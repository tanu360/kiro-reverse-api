package proxy

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
	"kiro-proxy/proxypool"
	"kiro-proxy/textfmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
)

const tokenRefreshSkewSeconds int64 = 120

type Handler struct {
	adminGuesses adminGuessLimiter
	pool         *pool.AccountPool

	startTime      int64
	stopRefresh    chan struct{}
	stopStatsSaver chan struct{}

	cachedModels    []ModelInfo
	modelsCacheMu   sync.RWMutex
	modelsCacheTime int64
	modelsSweep     sweepGroup
	// lastModelsSweep holds each account's outcome from the latest models sweep; guarded by modelsCacheMu.
	lastModelsSweep []accountResult
	promptCache     *promptCacheTracker
	// promptOverheads remembers what Kiro adds to each prompt; see prompt_overhead.go.
	promptOverheads *promptOverheads
	affinity        *sessionAffinity
	adminSessions   *adminSessionStore
	usageRefresh    *refreshScheduler
}

type thinkingStreamSource int

const (
	thinkingSourceUnknown thinkingStreamSource = iota
	thinkingSourceReasoningEvent
	thinkingSourceTagBlock
)

func allowReasoningSource(source *thinkingStreamSource) bool {
	if *source == thinkingSourceTagBlock {
		return false
	}
	*source = thinkingSourceReasoningEvent
	return true
}

func allowTagSource(source *thinkingStreamSource) bool {
	if *source == thinkingSourceReasoningEvent {
		return false
	}
	if *source == thinkingSourceUnknown {
		*source = thinkingSourceTagBlock
	}
	return *source == thinkingSourceTagBlock
}

func validateClaudeRequestShape(req *ClaudeRequest) string {
	if msg := validateClaudeToolChoice(req); msg != "" {
		return msg
	}
	if msg := validateClaudeStructuredOutput(req); msg != "" {
		return msg
	}
	if len(req.Messages) == 0 {
		return "messages must not be empty"
	}
	if msg := defaultClaudeMaxTokens(req); msg != "" {
		return msg
	}
	if msg := validateClaudeMessageRoles(req.Messages); msg != "" {
		return msg
	}
	if msg := validateClaudeMessageContent(req.Messages); msg != "" {
		return msg
	}
	if msg := validateClaudeThinkingBudget(req.Thinking, req.MaxTokens, req.interleavedThinking); msg != "" {
		if msg == budgetUnderMaxTokens && req.maxTokensDefaulted {
			//! The client sent no max_tokens; naming it alone left them looking for a value they never set.
			return fmt.Sprintf("%s (not set, so the model's maximum of %d)", budgetUnderMaxTokens, req.MaxTokens)
		}
		return msg
	}

	hasUserContext := false
	lastRole := ""
	for _, msg := range normalizeClaudeMessageRoles(req.Messages) {
		role := strings.TrimSpace(msg.Role)
		if role == "" {
			continue
		}
		lastRole = role
		if role != "user" {
			continue
		}

		text, images, toolResults := extractClaudeUserContent(msg.Content)
		if normalizeUserContent(text, len(images) > 0) != "" || len(toolResults) > 0 || len(extractDocuments(msg.Content)) > 0 {
			hasUserContext = true
		}
	}

	if lastRole == "assistant" {
		return "assistant-prefill final message is not supported; last message must be user"
	}
	if !hasUserContext {
		if msg := unreadableClaudeBlock(req.Messages); msg != "" {
			return msg
		}
		return "at least one non-empty user message is required"
	}
	return ""
}

const budgetUnderMaxTokens = "thinking.budget_tokens must be less than max_tokens"

func validateClaudeThinkingConfig(thinking *ClaudeThinkingConfig, maxTokens int) string {
	return validateClaudeThinkingBudget(thinking, maxTokens, false)
}

// validateClaudeThinkingBudget checks the thinking config. With interleaved thinking the
// budget covers every thinking block of the turn, so it may exceed max_tokens, as in the API.
func validateClaudeThinkingBudget(thinking *ClaudeThinkingConfig, maxTokens int, interleaved bool) string {
	if thinking == nil {
		return ""
	}

	kind := strings.ToLower(strings.TrimSpace(thinking.Type))
	switch kind {
	case "enabled":
		if maxTokens == 0 {
			return "thinking.type enabled cannot be used with max_tokens=0"
		}
		if thinking.BudgetTokens <= 0 {
			return "thinking.budget_tokens is required when thinking.type is enabled"
		}
		if thinking.BudgetTokens < 1024 {
			return "thinking.budget_tokens must be at least 1024"
		}
		if maxTokens > 0 && thinking.BudgetTokens >= maxTokens && !interleaved {
			return budgetUnderMaxTokens
		}
	case "adaptive":
		if thinking.BudgetTokens != 0 {
			return "thinking.budget_tokens is not supported when thinking.type is adaptive"
		}
	case "disabled":
		if thinking.BudgetTokens != 0 {
			return "thinking.budget_tokens is not supported when thinking.type is disabled"
		}
	default:
		return "thinking.type must be one of: enabled, adaptive, disabled"
	}

	display := strings.ToLower(strings.TrimSpace(thinking.Display))
	if display != "" && display != "summarized" && display != "omitted" && display != "updates" {
		return "thinking.display must be one of: summarized, omitted, updates"
	}
	if kind == "disabled" && display != "" {
		return "thinking.display is not supported when thinking.type is disabled"
	}

	return ""
}

type claudeThinkingResponseOptions struct {
	Format      string
	OmitDisplay bool
}

func resolveClaudeThinkingResponseOptions(thinking *ClaudeThinkingConfig, defaultFormat string) claudeThinkingResponseOptions {
	opts := claudeThinkingResponseOptions{Format: defaultFormat}
	if opts.Format == "" {
		opts.Format = "thinking"
	}
	if thinking == nil {
		return opts
	}

	display := strings.ToLower(strings.TrimSpace(thinking.Display))
	switch display {
	//! "updates" asks for progress notes between tool calls. Kiro has none; its thinking
	//! text is the closest thing, and it is what Claude Code got after dropping the field.
	case "summarized", "updates":
		opts.Format = "thinking"
	case "omitted":
		opts.Format = "thinking"
		opts.OmitDisplay = true
	}

	return opts
}

func validateOpenAIRequestShape(req *OpenAIRequest) string {
	msg := validateOpenAIRequestShapeAs(req, chatRequestChecks)
	if msg == chatRequestChecks.noUserText {
		if unreadable := unreadableChatPart(req.Messages); unreadable != "" {
			return unreadable
		}
	}
	return msg
}

// validateOpenAIRequestShapeAs runs the Chat checks, worded for the API the request came in on.
func validateOpenAIRequestShapeAs(req *OpenAIRequest, checks openAIRequestChecks) string {
	if msg := validateOpenAIToolChoice(req); msg != "" {
		return msg
	}
	if msg := validateChatResponseFormat(req); msg != "" {
		return msg
	}
	if msg := validateOpenAIOutputOptions(req, checks.maxTokens); msg != "" {
		return msg
	}
	if len(req.Messages) == 0 {
		return "messages must not be empty"
	}

	if msg := validateOpenAIMessageRoles(req.Messages); msg != "" {
		return msg
	}

	hasNonSystem := false
	hasUserContext := false
	lastRole := ""
	for _, msg := range req.Messages {
		role := strings.TrimSpace(msg.Role)
		if role == "" {
			continue
		}
		if role != "system" && role != "developer" {
			hasNonSystem = true
			lastRole = role
		}

		if role != "user" {
			continue
		}
		text, images := extractOpenAIUserContent(msg.Content)
		if normalizeUserContent(text, len(images) > 0) != "" || len(extractDocuments(msg.Content)) > 0 {
			hasUserContext = true
		}
	}

	if !hasNonSystem {
		return checks.noNonSystem
	}
	if lastRole == "assistant" {
		return checks.prefill
	}
	if !hasUserContext {
		return checks.noUserText
	}
	return ""
}

func NewHandler() *Handler {

	applyProxyConfig(config.GetProxyURL())

	h := &Handler{
		pool:            pool.GetPool(),
		startTime:       time.Now().Unix(),
		stopRefresh:     make(chan struct{}),
		stopStatsSaver:  make(chan struct{}),
		promptCache:     newPromptCacheTracker(defaultPromptCacheTTL),
		promptOverheads: loadPromptOverheads(),
		affinity:        newSessionAffinity(),
		adminSessions:   newAdminSessionStore(),
		usageRefresh:    newRefreshScheduler(config.GetUsageRefreshInterval),
	}

	restoreNativeModels()
	go h.backgroundRefresh()

	go h.backgroundObserveTick()

	//! Before the request log is read: rows from older versions still hold raw client keys.
	if err := scrubStoredRequestKeys(); err != nil {
		logger.Warnf("[Observe] Failed to mask older client keys: %v", err)
	}
	if err := reclassifyStoredProxyFailures(); err != nil {
		logger.Warnf("[Observe] Failed to file older proxy failures: %v", err)
	}

	//! The model mix sums the whole request log, so it warms in the background
	//! and the listener does not wait on a full-table scan.
	if warmup, err := getObserveStore().loadWindowFromDB(); err != nil {
		logger.Warnf("[Observe] Failed to load: %v", err)
	} else {
		go func() {
			if err := warmup.run(); err != nil {
				logger.Warnf("[Observe] Failed to load the model mix: %v", err)
			}
		}()
	}

	go h.backgroundBackupScheduler()
	go h.backgroundCooldownSaver()
	go h.backgroundLogRetention()
	startProxyPool()
	go h.backgroundAlerts()
	return h
}

func (h *Handler) backgroundRefresh() {
	h.runHousekeeping(h.stopRefresh)
}

// refreshAllAccounts is the account half of the housekeeping sweep; every is the
// interval in force, which decides which tokens and usage are due.
func (h *Handler) refreshAllAccounts(every time.Duration) {
	accounts := config.GetAccounts()
	start := time.Now()
	now := start.Unix()

	forEachAccount(accounts, backgroundRefreshWorkers, func(_ int, account *config.Account) {
		if !account.Enabled || account.AccessToken == "" {
			return
		}
		if account.Silent || (account.BanStatus != "" && account.BanStatus != "ACTIVE") {
			return
		}

		if tokenExpiresBeforeNextSweep(account, time.Now().Unix(), every) {
			//! force: without it the refresh is skipped while the token is outside the 2-minute skew.
			//! A token another caller already rotated is still left alone.
			if err := refreshStoredAccount(context.Background(), account, true); err != nil {
				logger.Warnf("[BackgroundRefresh] Token refresh failed for %s: %v", account.Email, err)
				return
			}
		}

		if usageInfoFresh(account.LastRefresh, now, every) {
			return
		}

		info, err := RefreshAccountInfo(account)
		if err != nil {
			logger.Warnf("[BackgroundRefresh] Failed to refresh %s: %v", account.Email, err)
			return
		}

		config.UpdateAccountInfo(account.ID, *info)
		logger.Infof("[BackgroundRefresh] Refreshed %s: %s %.1f/%.1f", account.Email, info.SubscriptionType, info.UsageCurrent, info.UsageLimit)
	})
	h.pool.Reload()
	logger.Infof("[BackgroundRefresh] Sweep finished: %s in %s (%s)",
		textfmt.Count(len(accounts), "account", "accounts"), textfmt.Duration(time.Since(start)),
		textfmt.Count(max(1, min(backgroundRefreshWorkers, len(accounts))), "worker", "workers"))
	kickAlerts()
}

func (h *Handler) validateApiKey(r *http.Request) bool {
	_, err := h.authenticate(r)
	return err == nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	logger.Debugf("[HTTP] %s %s from %s", r.Method, path, r.RemoteAddr)

	//! The wildcard belongs to the inference API, which any client may call.
	//! The admin API holds account credentials, so no origin may read it cross-site.
	isAdminPath := strings.HasPrefix(path, "/admin/")
	if !isAdminPath {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch")
		w.Header().Set("Access-Control-Expose-Headers", "x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens")
	}

	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	if isClientAPIPath(path) {
		var finish func()
		w, r, finish = wrapClientResponse(w, r)
		defer finish()
	}

	if endpoint := requestEndpointForPath(path); endpoint != "" {
		r = withRequestTrace(r, endpoint)
		r = r.WithContext(withRPMPicks(r.Context(), h.pool))
	}

	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
	bodyErr := decompressRequestBody(r)
	_ = controller.SetReadDeadline(time.Time{})
	if err := bodyErr; err != nil {
		logger.Warnf("[HTTP] decompress failed: %v", err)
		status := http.StatusBadRequest
		if errors.Is(err, errRequestBodyTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		http.Error(w, err.Error(), status)
		return
	}

	switch {

	case path == "/v1/messages" || path == "/messages" || path == "/anthropic/v1/messages":
		ar := h.authenticateForClaudeRequest(w, r)
		if ar == nil {
			return
		}
		h.handleClaudeMessages(w, ar)
	case path == "/v1/messages/count_tokens" || path == "/messages/count_tokens":
		ar := h.authenticateForClaude(w, r)
		if ar == nil {
			return
		}
		h.handleCountTokens(w, ar)
	case path == "/v1/chat/completions" || path == "/chat/completions":
		ar := h.authenticateForOpenAIRequest(w, r)
		if ar == nil {
			return
		}
		h.handleOpenAIChat(w, ar)
	case path == "/v1/responses" || path == "/responses":
		ar := h.authenticateForOpenAIRequest(w, r)
		if ar == nil {
			return
		}
		h.handleOpenAIResponses(w, ar)
	case strings.HasPrefix(path, "/v1/responses/") || strings.HasPrefix(path, "/responses/"):
		ar := h.authenticateForOpenAI(w, r)
		if ar == nil {
			return
		}
		id := strings.TrimPrefix(strings.TrimPrefix(path, "/v1/responses/"), "/responses/")
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			h.apiGetOpenAIResponse(w, ar, id)
		case http.MethodDelete:
			h.apiDeleteOpenAIResponse(w, ar, id)
		default:
			sendMethodNotAllowed(w, ar, errorShapeOpenAI, http.MethodGet, http.MethodDelete)
		}
	case path == "/v1/models" || path == "/models":
		ar := h.authenticateForModels(w, r)
		if ar == nil {
			return
		}
		h.handleModels(w, ar)
	case strings.HasPrefix(path, "/v1/models/") || strings.HasPrefix(path, "/models/"):
		ar := h.authenticateForModels(w, r)
		if ar == nil {
			return
		}
		h.handleModel(w, ar, strings.TrimPrefix(strings.TrimPrefix(path, "/v1/models/"), "/models/"))
	case path == "/v1/codex/models" || path == "/codex/models" || path == "/v1/codex-models":
		ar := h.authenticateForOpenAI(w, r)
		if ar == nil {
			return
		}
		h.handleCodexModels(w, ar)
	case path == "/api/event_logging/batch":

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write([]byte(`{"status":"ok"}`))

	case strings.HasPrefix(path, "/admin/api/"):
		h.handleAdminAPI(w, r)
	case path == "/admin" || strings.HasPrefix(path, "/admin/"):
		redirectLegacyAdminPath(w, r)

	//! A browser opening the root gets the admin UI; API clients and monitors that probe "/"
	//! keep getting the health JSON they always did.
	case path == "/health" || (path == "/" && !wantsHTML(r)):
		h.handleHealth(w, r)

	case path == "/v1/stats":
		if !h.validateApiKey(r) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(401)
			json.NewEncoder(w).Encode(map[string]string{"error": "Invalid or missing API key"})
			return
		}
		h.handleStats(w, r)

	case strings.HasPrefix(path, "/v1/"):
		sendClientNotFound(w, r)

	default:
		// The admin UI at the root: its files, and index.html for the pages a browser opens.
		defaultAdminUI().ServeHTTP(w, r)
	}
}

func (h *Handler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"version": config.Version,
		"uptime":  time.Now().Unix() - h.startTime,
	})
}

func accountCreditTotals(accounts []config.Account) (float64, float64) {
	var used, limit float64
	for _, account := range accounts {
		used += account.UsageCurrent
		limit += account.UsageLimit
	}
	return used, limit
}

func (h *Handler) statusPayload(includeAdmin bool) map[string]interface{} {
	requestStats, err := queryPersistedRequestStats()
	if err != nil {
		logger.Warnf("[Stats] Failed to query request stats: %v", err)
	}

	accounts := config.GetAccounts()
	accountCreditsUsed, accountCreditsLimit := accountCreditTotals(accounts)
	payload := map[string]interface{}{
		"status":              "ok",
		"version":             config.Version,
		"accounts":            len(accounts),
		"available":           h.pool.AvailableCount(),
		"accountCreditsUsed":  accountCreditsUsed,
		"accountCreditsLimit": accountCreditsLimit,
		"totalRequests":       requestStats.TotalRequests,
		"successRequests":     requestStats.SuccessRequests,
		"failedRequests":      requestStats.FailedRequests,
		"totalTokens":         requestStats.TotalTokens,
		"totalCredits":        requestStats.TotalCredits,
		"successTokens":       requestStats.SuccessTokens,
		"successInTokens":     requestStats.SuccessInTokens,
		"successOutTokens":    requestStats.SuccessOutTokens,
		"successCredits":      requestStats.SuccessCredits,
		"totalErrorEvents":    requestStats.TotalErrorEvents,
		"uptime":              time.Now().Unix() - h.startTime,
	}

	if includeAdmin {
		totalBanned := 0
		todayBanned := 0
		totalExhausted := 0
		now := time.Now()
		todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
		for _, account := range accounts {
			if account.BanStatus != "" && account.BanStatus != "ACTIVE" {
				totalBanned++
				if account.BanTime >= todayStart {
					todayBanned++
				}
			}
			if account.UsageLimit > 0 && account.UsageCurrent >= account.UsageLimit {
				totalExhausted++
			}
		}
		payload["totalBanned"] = totalBanned
		payload["todayBanned"] = todayBanned
		payload["totalExhausted"] = totalExhausted
	}
	return payload
}

func (h *Handler) handleStats(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(h.statusPayload(false))
}

// listedModels is what /v1/models lists for the request's API key.
func (h *Handler) listedModels(r *http.Request) []map[string]interface{} {
	h.modelsCacheMu.RLock()
	cached := h.cachedModels
	h.modelsCacheMu.RUnlock()
	if len(cached) == 0 {
		h.refreshModelsCache()
		h.modelsCacheMu.RLock()
		cached = h.cachedModels
		h.modelsCacheMu.RUnlock()
	}

	thinkingSuffix := config.GetThinkingConfig().Suffix

	models := buildAnthropicModelsResponse(cached, thinkingSuffix)
	if len(models) == 0 {
		models = fallbackAnthropicModels(thinkingSuffix)
	}
	models = h.filterModelMapsForAPIKey(r.Context(), models, thinkingSuffix)

	//! gpt-4o and gpt-4 are not listed by hand: no account serves them and no default
	//! mapping points them anywhere, so they only failed. A model mapping still adds them.
	models = append(models, buildModelInfo("auto", "kiro-proxy", true))
	models = appendConfiguredModelAliases(models, thinkingSuffix)
	return models
}

func (h *Handler) handleModels(w http.ResponseWriter, r *http.Request) {
	if refuseMethod(w, r, errorShapeByHeader, http.MethodGet) {
		return
	}
	writeModelsList(w, r, h.listedModels(r))
}

func buildAnthropicModelsResponse(cached []ModelInfo, thinkingSuffix string) []map[string]interface{} {
	if len(cached) == 0 {
		return nil
	}

	models := make([]map[string]interface{}, 0, len(cached)*2)
	if len(cached) > 0 {
		for _, m := range cached {
			supportsImage := modelSupportsImage(m.InputTypes)
			models = append(models, buildModelInfo(m.ModelId, "anthropic", supportsImage))

			models = append(models, buildModelInfo(m.ModelId+thinkingSuffix, "anthropic", supportsImage))
		}
	}
	return models
}

func fallbackAnthropicModels(thinkingSuffix string) []map[string]interface{} {
	return []map[string]interface{}{
		buildModelInfo("claude-sonnet-5", "anthropic", true),
		buildModelInfo("claude-sonnet-5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-opus-5", "anthropic", true),
		buildModelInfo("claude-opus-5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-haiku-4.5", "anthropic", true),
		buildModelInfo("claude-haiku-4.5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-sonnet-4.5", "anthropic", true),
		buildModelInfo("claude-sonnet-4.5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-opus-4.5", "anthropic", true),
		buildModelInfo("claude-opus-4.5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-sonnet-4", "anthropic", true),
		buildModelInfo("claude-sonnet-4"+thinkingSuffix, "anthropic", true),
	}
}

func modelSupportsImage(inputTypes []string) bool {
	for _, t := range inputTypes {
		lt := strings.ToLower(t)
		if strings.Contains(lt, "image") || strings.Contains(lt, "vision") {
			return true
		}
	}
	return false
}

func buildModelInfo(id, ownedBy string, supportsImage bool) map[string]interface{} {
	modalities := []string{"text"}
	if supportsImage {
		modalities = append(modalities, "image")
	}
	modalitiesMap := map[string][]string{
		"input":  modalities,
		"output": {"text"},
	}

	return map[string]interface{}{
		"id":       id,
		"object":   "model",
		"owned_by": ownedBy,
		// type, display_name and created_at are the Anthropic shape, created the OpenAI one.
		"type":             "model",
		"display_name":     modelDisplayName(id),
		"created_at":       modelsCreatedAt.Format(time.RFC3339),
		"created":          modelsCreatedAt.Unix(),
		"supports_image":   supportsImage,
		"input_modalities": modalities,
		"modalities":       modalitiesMap,
		"capabilities": map[string]bool{
			"vision":       supportsImage,
			"image":        supportsImage,
			"image_vision": supportsImage,
		},
		"info": map[string]interface{}{
			"meta": map[string]interface{}{
				"capabilities": map[string]bool{
					"vision":       supportsImage,
					"image_vision": supportsImage,
				},
			},
		},
	}
}

// refreshModelsCache lists models on every enabled account. /v1/models, the
// admin panel and the timer can all ask at once; they share one sweep.
func (h *Handler) refreshModelsCache() {
	h.modelsSweep.Do(h.sweepModelsCache)
}

func (h *Handler) sweepModelsCache() {
	accounts := config.GetEnabledAccounts()
	results := make([]accountResult, len(accounts))
	defer func() {
		h.modelsCacheMu.Lock()
		h.lastModelsSweep = results
		h.modelsCacheMu.Unlock()
	}()
	if len(accounts) == 0 {
		return
	}

	listed := make([][]ModelInfo, len(accounts))
	forEachAccount(accounts, backgroundRefreshWorkers, func(i int, account *config.Account) {
		results[i] = accountResult{ID: account.ID}
		if err := h.ensureValidToken(account); err != nil {
			logger.Warnf("[ModelsCache] Skip %s token refresh failed: %v", account.Email, err)
			h.handleBackgroundAccountFailure(account, err)
			results[i].fail(&tokenRefreshError{prefix: "token refresh failed", err: err})
			return
		}

		models, err := ListAvailableModels(account)
		if err != nil {
			results[i].fail(err)
			//! Listing models is housekeeping on a timer, not traffic. Disabling or
			//! cooling an account here takes it out of rotation over a request no
			//! client made; real requests decide account health.
			logger.Warnf("[ModelsCache] Failed to refresh for %s: %v", account.Email, err)
			return
		}

		modelIDs := make([]string, 0, len(models))
		for _, m := range models {
			modelIDs = append(modelIDs, m.ModelId)
		}
		h.pool.SetModelList(account.ID, modelIDs)
		listed[i] = models
		results[i].OK = true
	})

	//! Merge in account order, not completion order, so /v1/models lists the
	//! same models in the same order on every sweep.
	aggregated := make([]ModelInfo, 0)
	for _, models := range listed {
		aggregated = mergeUniqueModels(aggregated, models)
	}

	if len(aggregated) > 0 {
		h.modelsCacheMu.Lock()
		h.cachedModels = aggregated
		publishNativeModels(h.cachedModels)
		h.modelsCacheTime = time.Now().Unix()
		h.modelsCacheMu.Unlock()
		logger.Infof("[ModelsCache] Cached %s", textfmt.Count(len(aggregated), "model", "models"))
		rememberNativeModels(aggregated)
	}
}

func (h *Handler) fetchAndCacheAccountModels(account *config.Account) error {
	if err := h.ensureValidToken(account); err != nil {
		return &tokenRefreshError{prefix: "token refresh failed", err: err}
	}
	models, err := ListAvailableModels(account)
	if err != nil {
		return err
	}
	modelIDs := make([]string, 0, len(models))
	for _, m := range models {
		modelIDs = append(modelIDs, m.ModelId)
	}
	h.pool.SetModelList(account.ID, modelIDs)

	h.modelsCacheMu.Lock()
	h.cachedModels = mergeUniqueModels(h.cachedModels, models)
	publishNativeModels(h.cachedModels)
	h.modelsCacheTime = time.Now().Unix()
	h.modelsCacheMu.Unlock()

	logger.Infof("[ModelsCache] Refreshed %s for account %s", textfmt.Count(len(models), "model", "models"), account.Email)
	return nil
}

func (h *Handler) apiRefreshAccountModels(w http.ResponseWriter, _ *http.Request, id string) {
	accounts := config.GetAccounts()
	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	h.useLatestToken(account)
	if err := h.fetchAndCacheAccountModels(account); err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, codeModelsRefreshFailed)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(h.pool.GetModelList(id)),
	})
}

// useLatestToken copies the pool's newer token onto a config snapshot; the
// pool sees a refreshed token before config does.
func (h *Handler) useLatestToken(account *config.Account) {
	if latest := h.pool.GetByID(account.ID); latest != nil {
		account.AccessToken = latest.AccessToken
		account.RefreshToken = latest.RefreshToken
		account.ExpiresAt = latest.ExpiresAt
		account.ProfileArn = latest.ProfileArn
	}
}

func (h *Handler) apiRefreshAllAccountsModels(w http.ResponseWriter, _ *http.Request) {
	h.refreshModelsCache()
	h.modelsCacheMu.RLock()
	cachedLen := len(h.cachedModels)
	results := append([]accountResult{}, h.lastModelsSweep...)
	h.modelsCacheMu.RUnlock()
	refreshed, failed := countResults(results)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"accounts":  len(results),
		"refreshed": refreshed,
		"failed":    failed,
		"models":    cachedLen,
		"results":   results,
	})
}

func mergeUniqueModels(existing []ModelInfo, incoming []ModelInfo) []ModelInfo {
	if len(incoming) == 0 {
		return existing
	}

	indexByID := make(map[string]int, len(existing))
	merged := make([]ModelInfo, len(existing))
	copy(merged, existing)
	for i, model := range merged {
		indexByID[strings.ToLower(strings.TrimSpace(model.ModelId))] = i
	}

	for _, model := range incoming {
		key := strings.ToLower(strings.TrimSpace(model.ModelId))
		if key == "" {
			continue
		}
		if idx, ok := indexByID[key]; ok {
			merged[idx] = mergeModelInfo(merged[idx], model)
			continue
		}
		indexByID[key] = len(merged)
		merged = append(merged, model)
	}

	return merged
}

func mergeModelInfo(base ModelInfo, extra ModelInfo) ModelInfo {
	if base.ModelName == "" {
		base.ModelName = extra.ModelName
	}
	if base.Description == "" {
		base.Description = extra.Description
	}
	if base.RateMultiplier == 0 {
		base.RateMultiplier = extra.RateMultiplier
	}
	if base.TokenLimits == nil {
		base.TokenLimits = extra.TokenLimits
	}
	if base.AdditionalModelRequestFieldsSchema == nil {
		base.AdditionalModelRequestFieldsSchema = extra.AdditionalModelRequestFieldsSchema
	}
	base.InputTypes = mergeStringLists(base.InputTypes, extra.InputTypes)
	return base
}

func mergeStringLists(base []string, extra []string) []string {
	if len(extra) == 0 {
		return base
	}
	seen := make(map[string]bool, len(base)+len(extra))
	merged := make([]string, 0, len(base)+len(extra))
	for _, item := range base {
		key := strings.ToLower(strings.TrimSpace(item))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, item)
	}
	for _, item := range extra {
		key := strings.ToLower(strings.TrimSpace(item))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, item)
	}
	return merged
}

func (h *Handler) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	if refuseMethod(w, r, errorShapeAnthropic, http.MethodPost) {
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.sendClaudeError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	var req ClaudeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.sendClaudeError(w, 400, "invalid_request_error", clientJSONError(err))
		return
	}
	noteResponseModel(r.Context(), req.Model)
	//! count_tokens has no max_tokens field and the SDKs send none, so the budget is checked
	//! against max_tokens only when the client sent one.
	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = math.MaxInt
	}
	if msg := validateClaudeCountTokensShape(&req); msg != "" {
		h.sendClaudeError(w, 400, "invalid_request_error", msg)
		return
	}
	req.interleavedThinking = claudeInterleavedThinking(r, req.Model)
	if msg := validateClaudeThinkingBudget(req.Thinking, maxTokens, req.interleavedThinking); msg != "" {
		h.sendClaudeError(w, 400, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := resolveClaudeThinkingMode(req.Model, req.Thinking, thinkingCfg.Suffix)
	req.Model = actualModel
	//! The API counts only for a model it serves; a count for one no account has would mislead.
	if h.pool != nil && !h.pool.AllowedKnowsModel(allowedAccountsFromContext(r.Context()), req.Model) {
		_, errType, message := h.noAccountError(r.Context(), req.Model, "api_error")
		h.sendClaudeError(w, http.StatusNotFound, errType, message)
		return
	}
	effectiveReq := cloneClaudeRequestForThinking(&req, thinking)

	estimatedTokens := estimateClaudeRequestInputTokens(effectiveReq) +
		structuredOutputPromptTokens(claudeStructuredOutputSpec(&req), estimateClaudeValueTokens(req.System) > 0)
	if estimatedTokens < 1 {
		estimatedTokens = 1
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]int{"input_tokens": estimatedTokens})
}

func (h *Handler) handleClaudeMessages(w http.ResponseWriter, r *http.Request) {
	h.handleClaudeMessagesInternal(w, r)
}

func (h *Handler) handleClaudeMessagesInternal(w http.ResponseWriter, r *http.Request) {
	apiKeyID := apiKeyIDFromContext(r.Context())
	apiKeyValue := apiKeyValueFromContext(r.Context())
	if refuseMethod(w, r, errorShapeAnthropic, http.MethodPost) {
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Failed to read request body")
		h.sendClaudeError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}
	body = inlineRemoteImages(r.Context(), body)

	var req ClaudeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, clientJSONError(err))
		h.sendClaudeError(w, 400, "invalid_request_error", clientJSONError(err))
		return
	}
	noteResponseModel(r.Context(), req.Model)
	req.interleavedThinking = claudeInterleavedThinking(r, req.Model)
	if msg := validateClaudeRequestShape(&req); msg != "" {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, requestLogModel(req.Model), 0, 0, 0, false, http.StatusBadRequest, msg)
		h.sendClaudeError(w, 400, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := resolveClaudeThinkingMode(req.Model, req.Thinking, thinkingCfg.Suffix)
	req.Model = actualModel
	effectiveReq := cloneClaudeRequestForThinking(&req, thinking)
	thinkingResponseOpts := resolveClaudeThinkingResponseOptions(req.Thinking, thinkingCfg.ClaudeFormat)
	estimatedInputTokens := estimateClaudeRequestInputTokens(effectiveReq)
	cacheProfile := h.promptCache.BuildClaudeProfile(effectiveReq, estimatedInputTokens)
	apiKeyReservation, err := reserveApiKeyUsage(apiKeyID, apiKeyValue, tokenBudget(estimatedInputTokens))
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusTooManyRequests, err.Error())
		markNoRetryForKeyLimit(w, err)
		h.sendClaudeError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	switch mode, query := claudeWebSearchModeFor(&req); mode {
	case claudeWebSearchDirect:
		h.handleClaudeDirectWebSearch(w, r, req.Model, query, estimatedInputTokens, apiKeyReservation, req.Stream)
		return
	case claudeWebSearchLoop:
		h.runClaudeWebSearchLoop(w, r, &req, thinking, thinkingResponseOpts, estimatedInputTokens, apiKeyReservation)
		return
	}

	kiroPayload := ClaudeToKiro(&req, thinking)
	kiroPayload.StopSequences = req.StopSequences
	h.applyReasoningEffort(kiroPayload, req.Model, claudeOutputEffort(&req))
	applyClaudeThinkingBudget(kiroPayload, req.Thinking)
	attachStructuredOutput(kiroPayload, claudeStructuredOutputSpec(&req), req.Stream)
	thinkingResponseOpts.Format = structuredOutputThinkingFormat(kiroPayload.StructuredOutput, thinkingResponseOpts.Format, "thinking")

	if req.Stream {
		h.handleClaudeStream(w, r, kiroPayload, req.Model, thinking, thinkingResponseOpts, estimatedInputTokens, cacheProfile, apiKeyReservation)
	} else {
		h.handleClaudeNonStream(w, r, kiroPayload, req.Model, thinking, thinkingResponseOpts, estimatedInputTokens, cacheProfile, apiKeyReservation)
	}
}

func (h *Handler) handleClaudeStream(w http.ResponseWriter, r *http.Request, payload *KiroPayload, model string, thinking bool, thinkingOpts claudeThinkingResponseOptions, estimatedInputTokens int, cacheProfile *promptCacheProfile, apiKeyReservation *apiKeyUsageReservation) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusInternalServerError, "Streaming not supported")
		h.sendClaudeError(w, 500, "api_error", "Streaming not supported")
		return
	}
	keepalive := newSSEKeepaliveWriter(w, flusher, claudePingKeepalive)
	defer keepalive.Close()
	w, flusher = keepalive, keepalive

	thinkingFormat := thinkingOpts.Format

	msgID := "msg_" + uuid.New().String()
	startInputTokens := estimatedInputTokens
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	messageStarted := false
	var messageStartUsage promptCacheUsage

	ensureMessageStart := func() {
		if messageStarted {
			return
		}
		h.sendSSE(w, flusher, "message_start", map[string]interface{}{
			"type": "message_start",
			"message": map[string]interface{}{
				"id":            msgID,
				"type":          "message",
				"role":          "assistant",
				"content":       []interface{}{},
				"model":         model,
				"stop_reason":   nil,
				"stop_sequence": nil,
				"usage":         buildClaudeUsageMap(startInputTokens, 0, messageStartUsage, cacheProfile != nil),
			},
		})
		messageStarted = true
	}

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(r.Context(), payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			traceAttemptStart(r.Context(), account, "")
			if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
				if r.Context().Err() != nil {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}
			cacheUsage := h.promptCache.Compute(account.ID, cacheProfile)
			messageStartUsage = cacheUsage

			var inputTokens, outputTokens int
			var credits float64
			var upstreamCache cacheTokenCounts
			var realInputTokens int
			var cut outputCut
			var toolUses []KiroToolUse
			var nextContentIndex int
			var rawContentBuilder strings.Builder
			var rawThinkingBuilder strings.Builder
			var upstreamStopReason string
			var stopSequence *string
			activeBlockIndex := -1
			activeBlockType := ""
			// pendingThinkingSignature waits for the thinking block it signs to close.
			var pendingThinkingSignature string

			closeActiveBlock := func() {
				if activeBlockIndex < 0 {
					return
				}
				if activeBlockType == "thinking" && pendingThinkingSignature != "" {
					h.sendSSE(w, flusher, "content_block_delta", claudeSignatureDeltaEvent(activeBlockIndex, pendingThinkingSignature))
					pendingThinkingSignature = ""
				}
				h.sendSSE(w, flusher, "content_block_stop", map[string]interface{}{
					"type":  "content_block_stop",
					"index": activeBlockIndex,
				})
				activeBlockIndex = -1
				activeBlockType = ""
			}

			startContentBlock := func(blockType string) {
				if activeBlockType == blockType {
					return
				}
				ensureMessageStart()
				closeActiveBlock()

				idx := nextContentIndex
				nextContentIndex++

				if blockType == "thinking" {
					h.sendSSE(w, flusher, "content_block_start", map[string]interface{}{
						"type":  "content_block_start",
						"index": idx,
						"content_block": map[string]string{
							"type":     "thinking",
							"thinking": "",
						},
					})
				} else {
					h.sendSSE(w, flusher, "content_block_start", map[string]interface{}{
						"type":  "content_block_start",
						"index": idx,
						"content_block": map[string]string{
							"type": "text",
							"text": "",
						},
					})
				}

				activeBlockIndex = idx
				activeBlockType = blockType
			}

			var textBuffer string
			var inThinkingBlock bool
			var dropTagThinking bool
			var thinkingSource thinkingStreamSource
			var thinkingStarted bool
			var eventThinkingOpen bool
			var sawVisibleText bool

			sendText := func(text string, thinkingState int) {
				if thinkingState == 0 {
					//! Kiro leaves "\n\n" after the closing thinking tag. The non-stream answer
					//! trims it, so the streamed one drops what comes before its first visible text.
					if !sawVisibleText {
						text = strings.TrimLeft(text, " \t\r\n")
						sawVisibleText = text != ""
					}
					if text == "" {
						return
					}
					startContentBlock("text")
					h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
						"type":  "content_block_delta",
						"index": activeBlockIndex,
						"delta": map[string]string{"type": "text_delta", "text": text},
					})
					return
				}

				if !thinking {
					return
				}

				switch thinkingFormat {
				case "think":
					var outputText string
					switch thinkingState {
					case 1:
						outputText = "<think>" + text
					case 2:
						outputText = text
					case 3:
						outputText = text + "</think>"
					}
					if outputText == "" {
						return
					}
					startContentBlock("text")
					h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
						"type":  "content_block_delta",
						"index": activeBlockIndex,
						"delta": map[string]string{"type": "text_delta", "text": outputText},
					})
				case "reasoning_content":
					if text == "" {
						return
					}
					startContentBlock("text")
					h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
						"type":  "content_block_delta",
						"index": activeBlockIndex,
						"delta": map[string]string{"type": "text_delta", "text": text},
					})
				default:
					if thinkingOpts.OmitDisplay {
						if thinkingState == 1 {
							startContentBlock("thinking")
							return
						}
						if thinkingState == 3 {
							if activeBlockType != "thinking" {
								startContentBlock("thinking")
							}
							closeActiveBlock()
						}
						return
					}
					if thinkingState == 3 && text == "" {
						if activeBlockType == "thinking" {
							closeActiveBlock()
						}
						return
					}
					if text != "" {
						startContentBlock("thinking")
						h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
							"type":  "content_block_delta",
							"index": activeBlockIndex,
							"delta": map[string]string{"type": "thinking_delta", "thinking": text},
						})
					}
					if thinkingState == 3 && activeBlockType == "thinking" {
						closeActiveBlock()
					}
				}
			}

			processClaudeText := func(text string, isThinking bool, forceFlush bool) {
				if isThinking && !thinking {
					return
				}

				if isThinking {
					if !allowReasoningSource(&thinkingSource) {
						return
					}
					if !thinkingStarted {
						sendText(text, 1)
						thinkingStarted = true
						eventThinkingOpen = true
					} else {
						sendText(text, 2)
					}
					return
				}

				if eventThinkingOpen {
					sendText("", 3)
					eventThinkingOpen = false
					thinkingStarted = false
				}

				textBuffer += text

				for {
					if !inThinkingBlock {
						thinkingStart := strings.Index(textBuffer, "<thinking>")
						if thinkingStart != -1 {
							if thinkingStart > 0 {
								sendText(textBuffer[:thinkingStart], 0)
							}
							textBuffer = textBuffer[thinkingStart+10:]
							inThinkingBlock = true
							dropTagThinking = !allowTagSource(&thinkingSource)
							thinkingStarted = false
						} else if forceFlush || len([]rune(textBuffer)) > 50 {
							runes := []rune(textBuffer)
							safeLen := len(runes)
							if !forceFlush {
								safeLen = max(0, len(runes)-15)
							}
							if safeLen > 0 {
								sendText(string(runes[:safeLen]), 0)
								textBuffer = string(runes[safeLen:])
							}
							break
						} else {
							break
						}
					} else {
						thinkingEnd := strings.Index(textBuffer, "</thinking>")
						if thinkingEnd != -1 {
							content := textBuffer[:thinkingEnd]
							if !dropTagThinking {
								if !thinkingStarted {
									sendText(content, 1)
									sendText("", 3)
								} else {
									sendText(content, 3)
								}
							}
							textBuffer = textBuffer[thinkingEnd+11:]
							inThinkingBlock = false
							dropTagThinking = false
							thinkingStarted = false
						} else if forceFlush {
							if textBuffer != "" {
								if !dropTagThinking {
									if !thinkingStarted {
										sendText(textBuffer, 1)
										sendText("", 3)
									} else {
										sendText(textBuffer, 3)
									}
								}
								textBuffer = ""
							}
							inThinkingBlock = false
							dropTagThinking = false
							thinkingStarted = false
							break
						} else {
							runes := []rune(textBuffer)
							if len(runes) > 20 {
								safeLen := len(runes) - 15
								if safeLen > 0 {
									if !dropTagThinking {
										if !thinkingStarted {
											sendText(string(runes[:safeLen]), 1)
											thinkingStarted = true
										} else {
											sendText(string(runes[:safeLen]), 2)
										}
									}
									textBuffer = string(runes[safeLen:])
								}
							}
							break
						}
					}
				}
			}

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if text == "" {
						return
					}
					if isThinking {
						rawThinkingBuilder.WriteString(text)
					} else {
						rawContentBuilder.WriteString(text)
					}
					processClaudeText(text, isThinking, false)
				},
				OnToolUse: func(tu KiroToolUse) {
					processClaudeText("", false, true)
					rawContentBuilder.WriteString(tu.Name)
					if b, err := json.Marshal(tu.Input); err == nil {
						rawContentBuilder.Write(b)
					}

					toolUses = append(toolUses, tu)
					ensureMessageStart()
					closeActiveBlock()

					idx := nextContentIndex
					nextContentIndex++

					h.sendSSE(w, flusher, "content_block_start", map[string]interface{}{
						"type":  "content_block_start",
						"index": idx,
						"content_block": map[string]interface{}{
							"type":  "tool_use",
							"id":    tu.ToolUseID,
							"name":  tu.Name,
							"input": map[string]interface{}{},
						},
					})

					inputJSON, _ := json.Marshal(tu.Input)
					h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
						"type":  "content_block_delta",
						"index": idx,
						"delta": map[string]interface{}{
							"type":         "input_json_delta",
							"partial_json": string(inputJSON),
						},
					})

					h.sendSSE(w, flusher, "content_block_stop", map[string]interface{}{
						"type":  "content_block_stop",
						"index": idx,
					})
				},
				OnComplete: func(inTok, outTok int) {
					inputTokens = inTok
					outputTokens = outTok
				},
				OnCredits: func(c float64) {
					credits = c
				},
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnOutputCut: cut.record,
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
				OnStopSequence: func(sequence string) { stopSequence = &sequence },
				OnCacheUsage: func(read, write int) {
					upstreamCache = cacheTokenCounts{Read: read, Write: write}
				},
				OnThinkingSignature: func(signature string) {
					if thinkingSource != thinkingSourceTagBlock {
						pendingThinkingSignature = signature
					}
				},
				OnRedactedThinking: func(data string) {
					if !allowReasoningSource(&thinkingSource) {
						return
					}
					processClaudeText("", false, true)
					ensureMessageStart()
					closeActiveBlock()
					idx := nextContentIndex
					nextContentIndex++
					h.sendSSE(w, flusher, "content_block_start", claudeRedactedThinkingStartEvent(idx, data))
					h.sendSSE(w, flusher, "content_block_stop", map[string]interface{}{"type": "content_block_stop", "index": idx})
				},
			}
			dropDisabledClaudeThinkingExtras(callback, thinking, thinkingFormat)

			err := callKiroAutoContinue(r.Context(), account, payload, callback, CallKiroAPIContext)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if !messageStarted {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					}
					break
				}
				//! The client already holds part of the answer; hand over the held-back tail before the error.
				processClaudeText("", false, true)
				if eventThinkingOpen {
					sendText("", 3)
				}
				closeActiveBlock()
				recordFinalRequestForApiKey(r.Context(), apiKeyReservation, account, model, 0, 0, 0, false, 500, err.Error())
				h.sendSSE(w, flusher, "error", map[string]interface{}{
					"type":  "error",
					"error": map[string]string{"type": "api_error", "message": upstreamErrorText(err)},
				})
				return
			}

			processClaudeText("", false, true)
			if eventThinkingOpen {
				sendText("", 3)
			}
			closeActiveBlock()

			outputContent, extractedReasoning := extractThinkingFromContent(rawContentBuilder.String())
			thinkingOutput := rawThinkingBuilder.String()
			if thinking && thinkingOutput == "" && extractedReasoning != "" {
				thinkingOutput = extractedReasoning
			}
			if !thinking {
				thinkingOutput = ""
			}
			estimatedOutputTokens := estimateClaudeOutputTokens(outputContent, thinkingOutput, toolUses)
			inputTokens, outputTokens = h.promptOverheads.finalizeUsage(currentMessageModelID(payload), cut, inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			recordObservedSuccess(r.Context(), apiKeyReservation, account, model, inputTokens, outputTokens, credits,
				resolveCacheTokens(upstreamCache, cacheTokensFromPromptCache(cacheUsage), inputTokens))
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.RecordOutcome(account.ID, true, inputTokens+outputTokens, credits)
			h.promptCache.Update(account.ID, cacheProfile)

			stopReason := mapClaudeStopReason(inferMaxTokensStop(upstreamStopReason, outputTokens, requestedMaxTokens(payload)), len(toolUses))

			ensureMessageStart()
			h.sendSSE(w, flusher, "message_delta", map[string]interface{}{
				"type": "message_delta",
				"delta": map[string]interface{}{
					"stop_reason":   stopReason,
					"stop_sequence": claudeStopSequence(stopReason, stopSequence),
				},
				"usage": buildClaudeUsageMap(inputTokens, outputTokens, cacheUsage, cacheProfile != nil),
			})

			h.sendSSE(w, flusher, "message_stop", map[string]interface{}{
				"type": "message_stop",
			})
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		status, errType, message := h.noAccountError(r.Context(), model, "api_error")
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, status, message)
		h.sendClaudeError(w, status, errType, message)
		return
	}

	recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendClaudeUpstreamError(w, lastErr)
}

func (h *Handler) sendSSE(w http.ResponseWriter, flusher http.Flusher, event string, data interface{}) {
	jsonData, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(jsonData))
	flusher.Flush()
}

func (h *Handler) recordSuccessForApiKey(apiKeyReservation *apiKeyUsageReservation, inputTokens, outputTokens int, credits float64) {
	if apiKeyReservation == nil {
		return
	}
	if err := apiKeyReservation.finalize(int64(inputTokens+outputTokens), credits); err != nil {
		logger.Warnf("[ApiKey] failed to finalize usage for key %s: %v", apiKeyReservation.id, err)
	}
}

// inputFromContextTokens removes the answer from Kiro's context count. Live (2026-11-02,
// 200K window): a 2-token answer read 4110, a 400-word answer 4642 and a 1500-word answer
// 5821 for near-identical prompts, so taking the count as input billed every answer twice.
func inputFromContextTokens(contextTokens, outputTokens, estimatedInputTokens int) int {
	//! outputTokens is usually a local estimate that runs above Kiro's own count, so the
	//! difference can undershoot; the request's own estimated size is a floor, capped by
	//! the context it is part of.
	return max(contextTokens-outputTokens, min(estimatedInputTokens, contextTokens))
}

func accountIdentity(account *config.Account) (string, string) {
	if account == nil {
		return "", ""
	}
	return account.ID, account.Email
}

const (
	//! 499 is the de facto "client closed request" status; nothing is written back to the gone client.
	clientClosedRequestStatus = 499
	clientDisconnectedMessage = "client disconnected"
)

func recordClientDisconnect(ctx context.Context, apiKeyReservation *apiKeyUsageReservation, account *config.Account, model string) {
	recordFinalRequestForApiKey(ctx, apiKeyReservation, account, model, 0, 0, 0, false, clientClosedRequestStatus, clientDisconnectedMessage)
}

func recordAttemptError(ctx context.Context, account *config.Account, model string, status int, err error) {
	if account == nil || err == nil {
		return
	}
	traceAttemptFailed(ctx, account, status, err)
	settleRPMPickFailure(ctx, account, err)
	getObserveStore().RecordFailure(account.ID, model)
	getObserveStore().RecordError(account.ID, account.Email, model, status, err.Error())
}

func recordFinalRequestForApiKey(ctx context.Context, apiKeyReservation *apiKeyUsageReservation, account *config.Account, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	recordFinalRequestWithAPIKey(ctx, apiKeyReservation.apiKeyID(), apiKeyReservation.apiKeyValue(), account, model, inTokens, outTokens, credits, success, status, message)
}

// recordFinalRequestWithAPIKey logs a request's final outcome and counts it
// against the account that answered last. Success paths that log through
// recordObservedSuccess count with pool.RecordOutcome themselves.
func recordFinalRequestWithAPIKey(ctx context.Context, apiKeyID, apiKey string, account *config.Account, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	accountID, email := accountIdentity(account)
	getObserveStore().RecordTracedRequest(requestTraceFromContext(ctx), accountID, apiKeyID, apiKey, email, model, inTokens, outTokens, credits, success, status, message)
	if accountID != "" {
		pool.GetPool().RecordOutcome(accountID, success, inTokens+outTokens, credits)
	}
}

func (h *Handler) handleClaudeNonStream(w http.ResponseWriter, r *http.Request, payload *KiroPayload, model string, thinking bool, thinkingOpts claudeThinkingResponseOptions, estimatedInputTokens int, cacheProfile *promptCacheProfile, apiKeyReservation *apiKeyUsageReservation) {
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(r.Context(), payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			traceAttemptStart(r.Context(), account, "")
			if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
				if r.Context().Err() != nil {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}
			cacheUsage := h.promptCache.Compute(account.ID, cacheProfile)

			var content string
			var thinkingContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var upstreamCache cacheTokenCounts
			var realInputTokens int
			var cut outputCut
			var upstreamStopReason string
			var thinkingSignature string
			var redactedThinking []string
			var stopSequence *string

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if isThinking {
						thinkingContent += text
					} else {
						content += text
					}
				},
				OnToolUse: func(tu KiroToolUse) {
					toolUses = append(toolUses, tu)
				},
				OnComplete: func(inTok, outTok int) {
					inputTokens = inTok
					outputTokens = outTok
				},
				OnCredits: func(c float64) {
					credits = c
				},
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnOutputCut: cut.record,
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
				OnStopSequence: func(sequence string) { stopSequence = &sequence },
				OnCacheUsage: func(read, write int) {
					upstreamCache = cacheTokenCounts{Read: read, Write: write}
				},
				//! All reasoning merges into one thinking block, so it carries the last signature.
				OnThinkingSignature: func(signature string) { thinkingSignature = signature },
				OnRedactedThinking:  func(data string) { redactedThinking = append(redactedThinking, data) },
			}
			dropDisabledClaudeThinkingExtras(callback, thinking, thinkingOpts.Format)

			err := callKiroAutoContinue(r.Context(), account, payload, callback, CallKiroAPIContext)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}

			thinkingFormat := thinkingOpts.Format
			finalContent, extractedReasoning := answerFromContent(content, upstreamStopReason)
			rawThinkingContent := thinkingContent
			if thinking && rawThinkingContent == "" && extractedReasoning != "" {
				rawThinkingContent = extractedReasoning
			}
			if !thinking {
				rawThinkingContent = ""
			}

			estimatedOutputTokens := estimateClaudeOutputTokens(finalContent, rawThinkingContent, toolUses)
			inputTokens, outputTokens = h.promptOverheads.finalizeUsage(currentMessageModelID(payload), cut, inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			recordObservedSuccess(r.Context(), apiKeyReservation, account, model, inputTokens, outputTokens, credits,
				resolveCacheTokens(upstreamCache, cacheTokensFromPromptCache(cacheUsage), inputTokens))
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.RecordOutcome(account.ID, true, inputTokens+outputTokens, credits)
			h.promptCache.Update(account.ID, cacheProfile)

			responseThinkingContent := rawThinkingContent
			includeEmptyThinkingBlock := thinking && thinkingOpts.OmitDisplay && rawThinkingContent != ""
			if includeEmptyThinkingBlock {
				responseThinkingContent = ""
			}

			if thinking && responseThinkingContent != "" {
				switch thinkingFormat {
				case "think":
					finalContent = "<think>" + responseThinkingContent + "</think>" + finalContent
					responseThinkingContent = ""
				case "reasoning_content":
					finalContent = responseThinkingContent + finalContent
					responseThinkingContent = ""
				default:
				}
			}

			resp := KiroToClaudeResponse(finalContent, responseThinkingContent, includeEmptyThinkingBlock, toolUses, inputTokens, outputTokens, model)
			resp.Content = applyClaudeThinkingExtras(resp.Content, thinkingSignature, redactedThinking)
			resp.StopReason = mapClaudeStopReason(inferMaxTokensStop(upstreamStopReason, outputTokens, requestedMaxTokens(payload)), len(toolUses))
			resp.StopSequence = claudeStopSequence(resp.StopReason, stopSequence)
			resp.Usage.InputTokens = billedClaudeInputTokens(inputTokens, cacheUsage)
			resp.Usage.CacheCreationInputTokens = cacheUsage.CacheCreationInputTokens
			resp.Usage.CacheReadInputTokens = cacheUsage.CacheReadInputTokens
			if cacheProfile != nil {
				resp.Usage.CacheCreation = &ClaudeCacheCreationUsage{
					Ephemeral5mInputTokens: cacheUsage.CacheCreation5mInputTokens,
					Ephemeral1hInputTokens: cacheUsage.CacheCreation1hInputTokens,
				}
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			json.NewEncoder(w).Encode(resp)
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		status, errType, message := h.noAccountError(r.Context(), model, "api_error")
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, status, message)
		h.sendClaudeError(w, status, errType, message)
		return
	}

	recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendClaudeUpstreamError(w, lastErr)
}

// noAccountError describes a request that no account took. A model that no
// enabled account lists is the client's mistake and gets 404; an empty or busy
// pool is ours and keeps 503 with the API's own server error type. Accounts
// held back only by the per-account RPM limit give 429 rate_limit_error. Only
// the accounts the request's API key may use count.
func (h *Handler) noAccountError(ctx context.Context, model, serverErrType string) (int, string, string) {
	allowed := allowedAccountsFromContext(ctx)
	if !h.pool.AllowedKnowsModel(allowed, model) {
		errType := "invalid_request_error"
		if serverErrType == "api_error" {
			errType = "not_found_error"
		}
		if allowed != nil {
			return http.StatusNotFound, errType, fmt.Sprintf("model %q is not available on any account this API key can use", model)
		}
		return http.StatusNotFound, errType, fmt.Sprintf("model %q is not available on any account", model)
	}
	if h.pool.BlockedByRPMLimitAllowed(model, allowed) {
		//! The window is known, so clients can wait for it instead of retrying at once.
		noteRetryAfter(ctx, h.pool.RPMRetryAfter(model, allowed))
		return http.StatusTooManyRequests, "rate_limit_error", fmt.Sprintf("All accounts reached the limit of %s per minute", textfmt.Count(config.GetAccountRPMLimit(), "request", "requests"))
	}
	//! Every account is cooling down or out of rotation; a known cooldown end tells clients when to retry.
	noteRetryAfter(ctx, h.pool.CooldownRetryAfter(model, allowed))
	return http.StatusServiceUnavailable, serverErrType, "No available accounts"
}

func (h *Handler) sendClaudeError(w http.ResponseWriter, status int, errType, message string) {
	if noRetryStatus(status) {
		markNoRetry(w)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"type": "error",
		"error": map[string]string{
			"type":    errType,
			"message": message,
		},
	})
}

func (h *Handler) handleOpenAIChat(w http.ResponseWriter, r *http.Request) {
	apiKeyID := apiKeyIDFromContext(r.Context())
	apiKeyValue := apiKeyValueFromContext(r.Context())
	if refuseMethod(w, r, errorShapeOpenAI, http.MethodPost) {
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Failed to read request body")
		h.sendOpenAIError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}
	body = inlineRemoteImages(r.Context(), body)

	var req OpenAIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, clientJSONError(err))
		h.sendOpenAIError(w, 400, "invalid_request_error", clientJSONError(err))
		return
	}
	noteResponseModel(r.Context(), req.Model)
	if msg := validateOpenAIRequestShape(&req); msg != "" {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, requestLogModel(req.Model), 0, 0, 0, false, http.StatusBadRequest, msg)
		h.sendOpenAIError(w, 400, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := ParseModelAndThinking(req.Model, thinkingCfg.Suffix)
	req.Model = actualModel
	thinking = resolveThinkingWithEffort(thinking, req.ReasoningEffort)
	estimatedInputTokens := estimateOpenAIRequestInputTokens(&req)
	apiKeyReservation, err := reserveApiKeyUsage(apiKeyID, apiKeyValue, tokenBudget(estimatedInputTokens))
	if err != nil {
		recordFinalRequestWithAPIKey(r.Context(), apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusTooManyRequests, err.Error())
		markNoRetryForKeyLimit(w, err)
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	req.MaxTokens = openAIMaxOutputTokens(&req)
	kiroPayload := OpenAIToKiro(&req, thinking)
	kiroPayload.StopSequences, _ = openAIStopSequences(req.Stop)
	h.applyReasoningEffort(kiroPayload, req.Model, req.ReasoningEffort)
	attachStructuredOutput(kiroPayload, chatStructuredOutputSpec(&req), req.Stream)

	if req.Stream {
		r = withChatStreamUsage(r, req.StreamOptions)
		h.handleOpenAIStream(w, r, kiroPayload, req.Model, thinking, estimatedInputTokens, apiKeyReservation)
	} else {
		h.handleOpenAINonStream(w, r, kiroPayload, req.Model, thinking, estimatedInputTokens, apiKeyReservation)
	}
}

func (h *Handler) handleOpenAIStream(w http.ResponseWriter, r *http.Request, payload *KiroPayload, model string, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusInternalServerError, "Streaming not supported")
		h.sendOpenAIError(w, 500, "server_error", "Streaming not supported")
		return
	}
	keepalive := newSSEKeepaliveWriter(w, flusher, sseCommentKeepalive)
	defer keepalive.Close()
	w, flusher = keepalive, keepalive

	thinkingFormat := structuredOutputThinkingFormat(payload.StructuredOutput, config.GetThinkingConfig().OpenAIFormat, "reasoning_content")

	chatID := "chatcmpl-" + uuid.New().String()
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(r.Context(), payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			traceAttemptStart(r.Context(), account, "")
			if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
				if r.Context().Err() != nil {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}

			var toolCalls []ToolCall
			var toolCallIndex int
			var inputTokens, outputTokens int
			var credits float64
			var upstreamCache cacheTokenCounts
			var realInputTokens int
			var cut outputCut
			var upstreamStopReason string
			var rawContentBuilder strings.Builder
			var rawReasoningBuilder strings.Builder
			var textBuffer string
			var inThinkingBlock bool
			var dropTagThinking bool
			var thinkingSource thinkingStreamSource
			var thinkingStarted bool
			var eventThinkingOpen bool
			//! Leading whitespace the model leaves after a thinking block is dropped, as the non-stream reply does.
			var sawContent, sawReasoning bool
			responseStarted := false

			sendChunk := func(content string, thinkingState int) {
				if content == "" && thinkingState == 2 {
					return
				}
				var chunk map[string]interface{}

				if thinkingState > 0 {
					if !thinking {
						return
					}
					switch thinkingFormat {
					case "thinking":
						var text string
						switch thinkingState {
						case 1:
							text = "<thinking>" + content
						case 2:
							text = content
						case 3:
							text = content + "</thinking>"
						}
						if text == "" {
							return
						}
						chunk = map[string]interface{}{
							"id":      chatID,
							"object":  "chat.completion.chunk",
							"created": time.Now().Unix(),
							"model":   model,
							"choices": []map[string]interface{}{{
								"index":         0,
								"delta":         map[string]string{"content": text},
								"finish_reason": nil,
							}},
						}
					case "think":
						var text string
						switch thinkingState {
						case 1:
							text = "<think>" + content
						case 2:
							text = content
						case 3:
							text = content + "</think>"
						}
						if text == "" {
							return
						}
						chunk = map[string]interface{}{
							"id":      chatID,
							"object":  "chat.completion.chunk",
							"created": time.Now().Unix(),
							"model":   model,
							"choices": []map[string]interface{}{{
								"index":         0,
								"delta":         map[string]string{"content": text},
								"finish_reason": nil,
							}},
						}
					default:
						if !sawReasoning {
							content = strings.TrimLeft(content, " \t\r\n")
						}
						if content == "" {
							return
						}
						sawReasoning = true
						chunk = map[string]interface{}{
							"id":      chatID,
							"object":  "chat.completion.chunk",
							"created": time.Now().Unix(),
							"model":   model,
							"choices": []map[string]interface{}{{
								"index":         0,
								"delta":         map[string]string{"reasoning_content": content},
								"finish_reason": nil,
							}},
						}
					}
				} else {
					if !sawContent {
						content = strings.TrimLeft(content, " \t\r\n")
					}
					if content == "" {
						return
					}
					sawContent = true
					chunk = map[string]interface{}{
						"id":      chatID,
						"object":  "chat.completion.chunk",
						"created": time.Now().Unix(),
						"model":   model,
						"choices": []map[string]interface{}{{
							"index":         0,
							"delta":         map[string]string{"content": content},
							"finish_reason": nil,
						}},
					}
				}
				if !responseStarted {
					withAssistantRole(chunk)
				}
				data, _ := json.Marshal(chunk)
				fmt.Fprintf(w, "data: %s\n\n", string(data))
				flusher.Flush()
				responseStarted = true
			}

			processText := func(text string, isThinking bool, forceFlush bool) {
				if isThinking && !thinking {
					return
				}

				if isThinking {
					if !allowReasoningSource(&thinkingSource) {
						return
					}
					if !thinkingStarted {
						sendChunk(text, 1)
						thinkingStarted = true
						eventThinkingOpen = true
					} else {
						sendChunk(text, 2)
					}
					return
				}

				if eventThinkingOpen {
					sendChunk("", 3)
					eventThinkingOpen = false
					thinkingStarted = false
				}

				textBuffer += text

				for {
					if !inThinkingBlock {
						thinkingStart := strings.Index(textBuffer, "<thinking>")
						if thinkingStart != -1 {
							if thinkingStart > 0 {
								sendChunk(textBuffer[:thinkingStart], 0)
							}
							textBuffer = textBuffer[thinkingStart+10:]
							inThinkingBlock = true
							dropTagThinking = !allowTagSource(&thinkingSource)
							thinkingStarted = false
						} else if forceFlush || len([]rune(textBuffer)) > 50 {
							runes := []rune(textBuffer)
							safeLen := len(runes)
							if !forceFlush {
								safeLen = max(0, len(runes)-15)
							}
							if safeLen > 0 {
								sendChunk(string(runes[:safeLen]), 0)
								textBuffer = string(runes[safeLen:])
							}
							break
						} else {
							break
						}
					} else {
						thinkingEnd := strings.Index(textBuffer, "</thinking>")
						if thinkingEnd != -1 {
							content := textBuffer[:thinkingEnd]
							if !dropTagThinking {
								if !thinkingStarted {
									sendChunk(content, 1)
									sendChunk("", 3)
								} else {
									sendChunk(content, 3)
								}
							}
							textBuffer = textBuffer[thinkingEnd+11:]
							inThinkingBlock = false
							dropTagThinking = false
							thinkingStarted = false
						} else if forceFlush {
							if textBuffer != "" {
								if !dropTagThinking {
									if !thinkingStarted {
										sendChunk(textBuffer, 1)
										sendChunk("", 3)
									} else {
										sendChunk(textBuffer, 3)
									}
								}
								textBuffer = ""
							}
							inThinkingBlock = false
							dropTagThinking = false
							thinkingStarted = false
							break
						} else {
							runes := []rune(textBuffer)
							if len(runes) > 20 {
								safeLen := len(runes) - 15
								if safeLen > 0 {
									if !dropTagThinking {
										if !thinkingStarted {
											sendChunk(string(runes[:safeLen]), 1)
											thinkingStarted = true
										} else {
											sendChunk(string(runes[:safeLen]), 2)
										}
									}
									textBuffer = string(runes[safeLen:])
								}
							}
							break
						}
					}
				}
			}

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if text == "" {
						return
					}
					if isThinking {
						rawReasoningBuilder.WriteString(text)
					} else {
						rawContentBuilder.WriteString(text)
					}
					processText(text, isThinking, false)
				},
				OnToolUse: func(tu KiroToolUse) {
					processText("", false, true)

					args, _ := json.Marshal(tu.Input)
					rawContentBuilder.WriteString(tu.Name)
					rawContentBuilder.Write(args)
					tc := ToolCall{ID: tu.ToolUseID, Type: "function"}
					tc.Function.Name = tu.Name
					tc.Function.Arguments = string(args)
					toolCalls = append(toolCalls, tc)

					chunk := map[string]interface{}{
						"id":      chatID,
						"object":  "chat.completion.chunk",
						"created": time.Now().Unix(),
						"model":   model,
						"choices": []map[string]interface{}{{
							"index": 0,
							"delta": map[string]interface{}{
								"tool_calls": []map[string]interface{}{{
									"index": toolCallIndex,
									"id":    tu.ToolUseID,
									"type":  "function",
									"function": map[string]string{
										"name":      tu.Name,
										"arguments": string(args),
									},
								}},
							},
							"finish_reason": nil,
						}},
					}
					toolCallIndex++
					if !responseStarted {
						withAssistantRole(chunk)
					}
					data, _ := json.Marshal(chunk)
					fmt.Fprintf(w, "data: %s\n\n", string(data))
					flusher.Flush()
					responseStarted = true
				},
				OnComplete: func(inTok, outTok int) {
					inputTokens = inTok
					outputTokens = outTok
				},
				OnCredits: func(c float64) {
					credits = c
				},
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnOutputCut: cut.record,
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
				OnCacheUsage: func(read, write int) {
					upstreamCache = cacheTokenCounts{Read: read, Write: write}
				},
			}

			err := callKiroAutoContinue(r.Context(), account, payload, callback, callKiroWithHostedSearch)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if !responseStarted {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					}
					break
				}
				//! Hand over the held-back tail, then fail loudly: ending without [DONE] alone reads as success to many clients.
				processText("", false, true)
				if eventThinkingOpen {
					sendChunk("", 3)
				}
				recordFinalRequestForApiKey(r.Context(), apiKeyReservation, account, model, 0, 0, 0, false, 500, err.Error())
				errData, _ := json.Marshal(map[string]interface{}{
					"error": map[string]string{"message": upstreamErrorText(err), "type": "server_error"},
				})
				fmt.Fprintf(w, "data: %s\n\n", string(errData))
				flusher.Flush()
				return
			}

			processText("", false, true)
			if eventThinkingOpen {
				sendChunk("", 3)
			}

			outputContent, extractedReasoning := extractThinkingFromContent(rawContentBuilder.String())
			reasoningOutput := rawReasoningBuilder.String()
			if thinking && reasoningOutput == "" && extractedReasoning != "" {
				reasoningOutput = extractedReasoning
			}
			if !thinking {
				reasoningOutput = ""
			}
			estimatedOutputTokens := estimateApproxTokens(outputContent) + estimateApproxTokens(reasoningOutput)
			for _, tc := range toolCalls {
				estimatedOutputTokens += estimateApproxTokens(tc.Function.Name)
				estimatedOutputTokens += estimateApproxTokens(tc.Function.Arguments)
			}
			inputTokens, outputTokens = h.promptOverheads.finalizeUsage(currentMessageModelID(payload), cut, inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			cacheDetails := resolveOpenAICacheUsage(h.promptCache, account.ID, payload, inputTokens)
			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			recordObservedSuccess(r.Context(), apiKeyReservation, account, model, inputTokens, outputTokens, credits,
				resolveCacheTokens(upstreamCache, cacheTokensFromOpenAIDetails(cacheDetails), inputTokens))
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.RecordOutcome(account.ID, true, inputTokens+outputTokens, credits)

			finishReason := mapOpenAIFinishReason(inferMaxTokensStop(upstreamStopReason, outputTokens, requestedMaxTokens(payload)), len(toolCalls))

			usage := buildOpenAIUsage(inputTokens, outputTokens, cacheDetails, reasoningTokenCount(reasoningOutput, outputTokens))
			created := time.Now().Unix()
			chunk := map[string]interface{}{
				"id":      chatID,
				"object":  "chat.completion.chunk",
				"created": created,
				"model":   model,
				"choices": []map[string]interface{}{{
					"index":         0,
					"delta":         map[string]interface{}{},
					"finish_reason": finishReason,
				}},
				"usage": usage,
			}
			//! With stream_options.include_usage the usage moves to its own chunk with empty choices, as OpenAI sends it.
			separateUsage := chatStreamWantsUsageChunk(r.Context())
			if separateUsage {
				delete(chunk, "usage")
			}
			if !responseStarted {
				withAssistantRole(chunk)
			}
			data, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\n", string(data))
			if separateUsage {
				data, _ = json.Marshal(chatUsageChunk(chatID, model, created, usage))
				fmt.Fprintf(w, "data: %s\n\n", string(data))
			}
			fmt.Fprintf(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		status, errType, message := h.noAccountError(r.Context(), model, "server_error")
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, status, message)
		h.sendOpenAIError(w, status, errType, message)
		return
	}

	recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendOpenAIUpstreamError(w, lastErr)
}

func (h *Handler) handleOpenAINonStream(w http.ResponseWriter, r *http.Request, payload *KiroPayload, model string, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest && !isUpstreamClientError(lastErr) {
		account := h.pickAccount(r.Context(), payload, model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			traceAttemptStart(r.Context(), account, "")
			if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
				if r.Context().Err() != nil {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}

			var content string
			var reasoningContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var upstreamCache cacheTokenCounts
			var realInputTokens int
			var cut outputCut
			var upstreamStopReason string

			callback := &KiroStreamCallback{
				OnText: func(text string, isThinking bool) {
					if isThinking {
						reasoningContent += text
					} else {
						content += text
					}
				},
				OnToolUse:  func(tu KiroToolUse) { toolUses = append(toolUses, tu) },
				OnComplete: func(inTok, outTok int) { inputTokens = inTok; outputTokens = outTok },
				OnCredits:  func(c float64) { credits = c },
				OnContextUsage: func(pct float64) {
					realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
				},
				OnOutputCut: cut.record,
				OnStopReason: func(reason string) {
					upstreamStopReason = reason
				},
				OnCacheUsage: func(read, write int) {
					upstreamCache = cacheTokenCounts{Read: read, Write: write}
				},
			}

			err := callKiroAutoContinue(r.Context(), account, payload, callback, callKiroWithHostedSearch)
			if err != nil {
				if isContextCanceledError(err) {
					recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
					return
				}
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(r.Context(), account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(r.Context(), totalAttempts)
				}
				break
			}

			finalContent, extractedReasoning := answerFromContent(content, upstreamStopReason)
			if thinking && reasoningContent == "" && extractedReasoning != "" {
				reasoningContent = extractedReasoning
			} else if !thinking {
				reasoningContent = ""
			}

			estimatedOutputTokens := estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)
			inputTokens, outputTokens = h.promptOverheads.finalizeUsage(currentMessageModelID(payload), cut, inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			cacheDetails := resolveOpenAICacheUsage(h.promptCache, account.ID, payload, inputTokens)
			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			recordObservedSuccess(r.Context(), apiKeyReservation, account, model, inputTokens, outputTokens, credits,
				resolveCacheTokens(upstreamCache, cacheTokensFromOpenAIDetails(cacheDetails), inputTokens))
			h.pool.RecordSuccess(account.ID)
			h.rememberAccount(payload, account)
			h.pool.RecordOutcome(account.ID, true, inputTokens+outputTokens, credits)

			thinkingFormat := structuredOutputThinkingFormat(payload.StructuredOutput, config.GetThinkingConfig().OpenAIFormat, "reasoning_content")
			resp := KiroToOpenAIResponseWithReasoning(finalContent, reasoningContent, toolUses, inputTokens, outputTokens, model, thinkingFormat)
			resp["usage"] = buildOpenAIUsage(inputTokens, outputTokens, cacheDetails, reasoningTokenCount(reasoningContent, outputTokens))
			if choices, ok := resp["choices"].([]map[string]interface{}); ok && len(choices) > 0 {
				choices[0]["finish_reason"] = mapOpenAIFinishReason(inferMaxTokensStop(upstreamStopReason, outputTokens, requestedMaxTokens(payload)), len(toolUses))
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			json.NewEncoder(w).Encode(resp)
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		status, errType, message := h.noAccountError(r.Context(), model, "server_error")
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, nil, model, 0, 0, 0, false, status, message)
		h.sendOpenAIError(w, status, errType, message)
		return
	}

	recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, model, 0, 0, 0, false, upstreamFailureStatus(lastErr), lastErr.Error())
	h.sendOpenAIUpstreamError(w, lastErr)
}

func (h *Handler) sendOpenAIError(w http.ResponseWriter, status int, errType, message string) {
	if noRetryStatus(status) {
		markNoRetry(w)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	code, param := openAIErrorCode(status, message)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"type":    errType,
			"message": message,
			"code":    code,
			"param":   param,
		},
	})
}

func (h *Handler) ensureValidToken(account *config.Account) error {
	return h.ensureValidTokenContext(context.Background(), account)
}

func (h *Handler) ensureValidTokenContext(ctx context.Context, account *config.Account) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if config.IsAPIKeyAccount(account) {
		if accountBearerToken(account) == "" {
			return fmt.Errorf("account %s has no Kiro API key", account.ID)
		}
		return nil
	}
	if account.ExpiresAt == 0 || time.Now().Unix() < account.ExpiresAt-tokenRefreshSkewSeconds {
		return nil
	}

	return refreshStoredAccount(ctx, account, false)
}

// adminPasswordMatches verifies the admin password in constant time, so a
// caller cannot learn the password one character at a time from response
// latency.
func adminPasswordMatches(supplied string) bool {
	if supplied == "" {
		return false
	}
	return secureCompare(supplied, config.GetPassword())
}

// authorizeAdmin gates every /admin/api route.
//
// Three credentials are accepted, in descending order of preference:
//   - X-Admin-Token: a session token the browser holds instead of the password.
//   - X-Admin-Password: the password itself, kept for scripts and curl.
//   - ?ticket= on /events only: EventSource cannot set headers, so it carries a
//     single-use credential that expires in adminTicketTTL. The password itself
//     is never accepted from the query string, where access logs would keep it.
func (h *Handler) authorizeAdmin(r *http.Request, path string) bool {
	if token := r.Header.Get("X-Admin-Token"); token != "" {
		return h.adminSessions.Valid(token)
	}
	if password := r.Header.Get("X-Admin-Password"); password != "" {
		return adminPasswordMatches(password)
	}
	if path == "/events" && r.Method == "GET" {
		return h.adminSessions.ConsumeTicket(r.URL.Query().Get("ticket"))
	}
	return false
}

func (h *Handler) handleAdminAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/admin/api")

	//! Login and the first-run password are the only routes that run before authorization.
	if path == "/session" && r.Method == "POST" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		h.apiCreateAdminSession(w, r)
		return
	}
	if path == "/first-run" && r.Method == "GET" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]string{"password": config.FirstRunPassword()})
		return
	}

	if r.Header.Get("X-Admin-Token") == "" && r.Header.Get("X-Admin-Password") != "" && !h.checkAdminPassword(w, r, r.Header.Get("X-Admin-Password")) {
		return
	}
	if !h.authorizeAdmin(r, path) {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")

	switch {
	case path == "/session" && r.Method == "DELETE":
		h.apiDeleteAdminSession(w, r)
	case path == "/session/ticket" && r.Method == "POST":
		h.apiCreateAdminTicket(w, r)
	case path == "/events" && r.Method == "GET":
		h.apiEventsStream(w, r)
	case path == "/accounts" && r.Method == "GET":
		h.apiGetAccounts(w, r)
	case path == "/accounts" && r.Method == "POST":
		h.apiAddAccount(w, r)
	case path == "/accounts/batch" && r.Method == "POST":
		h.apiBatchAccounts(w, r)
	case path == "/accounts/duplicates" && r.Method == "GET":
		h.apiListDuplicateAccounts(w, r)
	case path == "/accounts/duplicates/merge" && r.Method == "POST":
		h.apiMergeDuplicateAccounts(w, r)

	//! Match models/refresh before the generic /refresh route.
	case path == "/accounts/models/refresh" && r.Method == "POST":
		h.apiRefreshAllAccountsModels(w, r)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/models/refresh") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/models/refresh")
		h.apiRefreshAccountModels(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/refresh") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/refresh")
		h.apiRefreshAccount(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/test") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/test")
		h.apiTestAccount(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/models/cached") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/models/cached")
		h.apiGetAccountModelsCached(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/models") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/models")
		h.apiGetAccountModels(w, r, id)

	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/overage") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/overage")
		h.apiGetAccountOverage(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/overage") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/overage")
		h.apiSetAccountOverage(w, r, id)

	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/profiles") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/profiles")
		h.apiGetAccountProfiles(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/profile") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/profile")
		h.apiSetAccountProfile(w, r, id)

	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/full") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/full")
		h.apiGetAccountFull(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/relogin/confirm") && r.Method == "POST":
		h.apiConfirmRelogin(w, r, strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/relogin/confirm"))
	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/relogin/discard") && r.Method == "POST":
		h.apiDiscardRelogin(w, r, strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/relogin/discard"))
	case strings.HasPrefix(path, "/accounts/") && r.Method == "DELETE":
		h.apiDeleteAccount(w, r, strings.TrimPrefix(path, "/accounts/"))
	case strings.HasPrefix(path, "/accounts/") && r.Method == "PUT":
		h.apiUpdateAccount(w, r, strings.TrimPrefix(path, "/accounts/"))
	case path == "/auth/iam-sso/start" && r.Method == "POST":
		h.apiStartIamSso(w, r)
	case path == "/auth/iam-sso/complete" && r.Method == "POST":
		h.apiCompleteIamSso(w, r)
	case path == "/auth/microsoft-sso/start" && r.Method == "POST":
		h.apiStartMicrosoftSSO(w, r)
	case path == "/auth/microsoft-sso/complete" && r.Method == "POST":
		h.apiCompleteMicrosoftSSO(w, r)
	case path == "/auth/microsoft-sso/select-profile" && r.Method == "POST":
		h.apiSelectMicrosoftSSOProfile(w, r)
	case path == "/auth/microsoft-sso/cancel" && r.Method == "POST":
		h.apiCancelMicrosoftSSO(w, r)
	case path == "/auth/builderid/start" && r.Method == "POST":
		h.apiStartBuilderIdLogin(w, r)
	case path == "/auth/builderid/poll" && r.Method == "POST":
		h.apiPollBuilderIdAuth(w, r)
	case path == "/auth/sso-token" && r.Method == "POST":
		h.apiImportSsoToken(w, r)
	case path == "/auth/credentials" && r.Method == "POST":
		h.apiImportCredentials(w, r)
	case path == "/status" && r.Method == "GET":
		h.apiGetStatus(w, r)
	case path == "/settings" && r.Method == "GET":
		h.apiGetSettings(w, r)
	case path == "/settings" && r.Method == "POST":
		h.apiUpdateSettings(w, r)
	case path == "/stats" && r.Method == "GET":
		h.apiGetStats(w, r)
	case path == "/stats/reset" && r.Method == "POST":
		h.apiResetStats(w, r)
	case path == "/log-retention" && r.Method == "GET":
		h.apiGetLogRetention(w, r)
	case path == "/log-retention" && r.Method == "POST":
		h.apiUpdateLogRetention(w, r)
	case path == "/generate-machine-id" && r.Method == "GET":
		h.apiGenerateMachineId(w, r)
	case path == "/thinking" && r.Method == "GET":
		h.apiGetThinkingConfig(w, r)
	case path == "/thinking" && r.Method == "POST":
		h.apiUpdateThinkingConfig(w, r)
	case path == "/model-mappings" && r.Method == "GET":
		h.apiGetModelMappings(w, r)
	case path == "/model-mappings" && r.Method == "POST":
		h.apiUpdateModelMappings(w, r)
	case path == "/response-headers" && r.Method == "GET":
		h.apiGetResponseHeaders(w, r)
	case path == "/response-headers" && r.Method == "POST":
		h.apiUpdateResponseHeaders(w, r)
	case path == "/endpoint" && r.Method == "GET":
		h.apiGetEndpointConfig(w, r)
	case path == "/endpoint" && r.Method == "POST":
		h.apiUpdateEndpointConfig(w, r)
	case path == "/upstream" && r.Method == "GET":
		h.apiGetUpstreamConfig(w, r)
	case path == "/upstream" && r.Method == "POST":
		h.apiUpdateUpstreamConfig(w, r)
	case path == "/account-health" && r.Method == "GET":
		h.apiGetAccountHealth(w, r)
	case path == "/account-health" && r.Method == "POST":
		h.apiUpdateAccountHealth(w, r)
	case path == "/account-health/resume" && r.Method == "POST":
		h.apiResumeAccountHealth(w, r)
	case path == "/proxy" && r.Method == "GET":
		h.apiGetProxy(w, r)
	case path == "/proxy" && r.Method == "POST":
		h.apiUpdateProxy(w, r)
	case path == "/proxy-pool" || strings.HasPrefix(path, "/proxy-pool/"):
		h.handleProxyPoolAPI(w, r, strings.TrimPrefix(path, "/proxy-pool"))
	case path == "/prompt-filter" && r.Method == "GET":
		h.apiGetPromptFilter(w, r)
	case path == "/prompt-filter" && r.Method == "POST":
		h.apiUpdatePromptFilter(w, r)
	case path == "/version" && r.Method == "GET":
		h.apiGetVersion(w, r)
	case path == "/export" && r.Method == "POST":
		h.apiExportAccounts(w, r)
	case path == "/api-keys" && r.Method == "GET":
		h.apiListApiKeys(w, r)
	case path == "/api-keys" && r.Method == "POST":
		h.apiCreateApiKey(w, r)
	case strings.HasPrefix(path, "/api-keys/") && strings.HasSuffix(path, "/reset-usage") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api-keys/"), "/reset-usage")
		h.apiResetApiKeyUsage(w, r, id)
	case strings.HasPrefix(path, "/api-keys/") && strings.HasSuffix(path, "/regenerate") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api-keys/"), "/regenerate")
		h.apiRegenerateApiKey(w, r, id)
	case path == "/api-keys/usage" && r.Method == "GET":
		h.apiApiKeyUsage(w, r)
	case strings.HasPrefix(path, "/api-keys/") && r.Method == "GET":
		h.apiGetApiKey(w, r, strings.TrimPrefix(path, "/api-keys/"))
	case strings.HasPrefix(path, "/api-keys/") && r.Method == "PUT":
		h.apiUpdateApiKey(w, r, strings.TrimPrefix(path, "/api-keys/"))
	case strings.HasPrefix(path, "/api-keys/") && r.Method == "DELETE":
		h.apiDeleteApiKey(w, r, strings.TrimPrefix(path, "/api-keys/"))
	case path == "/observe/overview" && r.Method == "GET":
		h.apiObserveOverview(w, r)
	case path == "/observe/account-heatmap" && r.Method == "GET":
		h.apiObserveHeatmap(w, r)
	case path == "/observe/model-mix" && r.Method == "GET":
		h.apiObserveModelMix(w, r)
	case path == "/observe/recent-errors" && r.Method == "GET":
		h.apiObserveRecentErrors(w, r)
	case path == "/observe/recent-requests" && r.Method == "GET":
		h.apiObserveRecentRequests(w, r)
	case path == "/observe/account-activity" && r.Method == "GET":
		h.apiAccountActivity(w, r)
	case path == "/backups" && r.Method == "GET":
		h.apiBackupsList(w, r)
	case path == "/backups" && r.Method == "POST":
		h.apiBackupsCreate(w, r)
	case path == "/backups/restore" && r.Method == "POST":
		h.apiBackupsRestoreUpload(w, r)
	case path == "/backups/schedule" && r.Method == "GET":
		h.apiBackupsScheduleGet(w, r)
	case path == "/backups/schedule" && r.Method == "POST":
		h.apiBackupsScheduleUpdate(w, r)
	case strings.HasPrefix(path, "/backups/") && strings.HasSuffix(path, "/download") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/backups/"), "/download")
		h.apiBackupsDownload(w, r, id)
	case strings.HasPrefix(path, "/backups/") && strings.HasSuffix(path, "/restore") && r.Method == "POST":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/backups/"), "/restore")
		h.apiBackupsRestore(w, r, id)
	case strings.HasPrefix(path, "/backups/") && r.Method == "GET":
		h.apiBackupsGet(w, r, strings.TrimPrefix(path, "/backups/"))
	case strings.HasPrefix(path, "/backups/") && r.Method == "DELETE":
		h.apiBackupsDelete(w, r, strings.TrimPrefix(path, "/backups/"))
	case path == "/alerts" || strings.HasPrefix(path, "/alerts/"):
		h.handleAlertsAPI(w, r, path)
	default:
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

func (h *Handler) apiGetAccounts(w http.ResponseWriter, _ *http.Request) {
	accounts := config.GetAccounts()
	poolAccounts := h.pool.GetAllAccounts()

	statsMap := make(map[string]config.Account)
	for _, a := range poolAccounts {
		statsMap[a.ID] = a
	}

	result := make([]map[string]interface{}, len(accounts))
	for i, a := range accounts {
		stats := accountStats(statsMap, a)

		result[i] = map[string]interface{}{
			"id":                a.ID,
			"email":             a.Email,
			"userId":            a.UserId,
			"nickname":          a.Nickname,
			"notes":             a.Notes,
			"tags":              tagsOrEmpty(a.Tags),
			"authMethod":        a.AuthMethod,
			"provider":          a.Provider,
			"region":            a.Region,
			"profileArn":        a.ProfileArn,
			"profileArnPinned":  a.ProfileArnPinned,
			"activeRegion":      kiroRegionForProfile(&a, ""),
			"enabled":           a.Enabled,
			"silent":            a.Silent,
			"silentReason":      a.SilentReason,
			"silentTime":        a.SilentTime,
			"banStatus":         a.BanStatus,
			"banReason":         a.BanReason,
			"banTime":           a.BanTime,
			"expiresAt":         a.ExpiresAt,
			"hasToken":          a.AccessToken != "",
			"machineId":         a.MachineId,
			"weight":            a.Weight,
			"priority":          a.Priority,
			"overageStatus":     a.OverageStatus,
			"overageCapability": a.OverageCapability,
			"overageCap":        a.OverageCap,
			"overageRate":       a.OverageRate,
			"currentOverages":   a.CurrentOverages,
			"overageCheckedAt":  a.OverageCheckedAt,
			"proxyURL":          maskProxyURL(a.ProxyURL),
			"subscriptionType":  a.SubscriptionType,
			"subscriptionTitle": a.SubscriptionTitle,
			"daysRemaining":     a.DaysRemaining,
			"usageCurrent":      a.UsageCurrent,
			"usageLimit":        a.UsageLimit,
			"usagePercent":      a.UsagePercent,
			"nextResetDate":     a.NextResetDate,
			"lastRefresh":       a.LastRefresh,
			"trialUsageCurrent": a.TrialUsageCurrent,
			"trialUsageLimit":   a.TrialUsageLimit,
			"trialUsagePercent": a.TrialUsagePercent,
			"trialStatus":       a.TrialStatus,
			"trialExpiresAt":    a.TrialExpiresAt,
			"requestCount":      stats.RequestCount,
			"errorCount":        stats.ErrorCount,
			"totalTokens":       stats.TotalTokens,
			"totalCredits":      stats.TotalCredits,
			"lastUsed":          stats.LastUsed,
		}
	}
	json.NewEncoder(w).Encode(result)
}

// accountStats picks the live pool copy of an account's counters, else the
// persisted row. The pool holds only routable accounts; disabled, banned,
// suspended and over-limit ones keep their history in config.
func accountStats(poolStats map[string]config.Account, stored config.Account) config.Account {
	if stats, ok := poolStats[stored.ID]; ok {
		return stats
	}
	return stored
}

func (h *Handler) apiAddAccount(w http.ResponseWriter, r *http.Request) {
	var account config.Account
	if err := json.NewDecoder(r.Body).Decode(&account); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	if account.ID == "" {
		account.ID = auth.GenerateAccountID()
	}
	region, err := config.NormalizeAWSRegion(account.Region)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	account.Region = region
	if !config.ValidAccountPriority(account.Priority) {
		writePriorityRange(w)
		return
	}

	stored, updated, err := config.UpsertAccount(account)
	if err != nil {
		writeAdminErr(w, addAccountErrorStatus(err), err, "")
		return
	}

	h.pool.Reload()

	if stored.Enabled && stored.AccessToken != "" {
		go func(acc config.Account) {
			if err := h.fetchAndCacheAccountModels(&acc); err != nil {
				logger.Warnf("[ModelsCache] Auto-refresh failed for new account %s: %v", acc.Email, err)
			}
		}(stored)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "id": stored.ID, "updated": updated})
}

func (h *Handler) apiDeleteAccount(w http.ResponseWriter, _ *http.Request, id string) {
	if err := config.DeleteAccount(id); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiUpdateAccount(w http.ResponseWriter, r *http.Request, id string) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	priority, hasPriority, err := parseAccountPriority(updates)
	if err != nil {
		writePriorityRange(w)
		return
	}

	accounts := config.GetAccounts()
	var existing *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			existing = &accounts[i]
			break
		}
	}
	if existing == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}
	//! Checked before any field is written, so a bad proxy URL leaves the account untouched.
	proxyURL, hasProxyURL, proxyErr := accountProxyURLUpdate(updates, existing.ProxyURL)
	if proxyErr != nil {
		writeProxyURLError(w, proxyErr)
		return
	}
	metadata, err := parseMetadataPatch(updates)
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, err.Error())
		return
	}
	if err := metadata.apply(id); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	oldEnabled := existing.Enabled
	if v, ok := updates["enabled"].(bool); ok {
		existing.Enabled = v
		if v && existing.BanStatus != "" && existing.BanStatus != "ACTIVE" {
			existing.BanStatus = "ACTIVE"
			existing.BanReason = ""
			existing.BanTime = 0
			existing.Silent = false
			existing.SilentReason = ""
			existing.SilentTime = 0
		}
		if !v {
			keepOffForAdmin(existing)
		}
	}
	if v, ok := updates["nickname"].(string); ok {
		existing.Nickname = v
	}
	if v, ok := updates["machineId"].(string); ok {
		existing.MachineId = v
	}
	if v, ok := updates["weight"].(float64); ok {
		existing.Weight = int(v)
	}
	if hasPriority {
		existing.Priority = priority
	}
	if hasProxyURL {
		existing.ProxyURL = proxyURL
	}
	if v, ok := updates["silent"].(bool); ok {
		existing.Silent = v
		if v {
			existing.Enabled = false
			if reason, ok := updates["silentReason"].(string); ok && strings.TrimSpace(reason) != "" {
				existing.SilentReason = strings.TrimSpace(reason)
			} else if existing.SilentReason == "" {
				existing.SilentReason = "manual"
			}
			if existing.SilentTime == 0 {
				existing.SilentTime = time.Now().Unix()
			}
		} else {
			existing.SilentReason = ""
			existing.SilentTime = 0
		}
	}
	if err := config.UpdateAccount(id, *existing); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()

	if !oldEnabled && existing.Enabled && existing.AccessToken != "" {
		go func(acc config.Account) {
			if err := h.fetchAndCacheAccountModels(&acc); err != nil {
				logger.Warnf("[ModelsCache] Auto-refresh failed for re-enabled account %s: %v", acc.Email, err)
			}
		}(*existing)
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetAccountOverage(w http.ResponseWriter, r *http.Request, id string) {
	account := findAccountByID(id)
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
		writeAdminErrorDetail(w, http.StatusBadGateway, codeTokenRefreshFailed, err.Error(), err.Error())
		return
	}
	snap, err := FetchOverageStatus(account)
	if err != nil {
		writeAdminErr(w, http.StatusBadGateway, err, codeOverageFailed)
		return
	}
	if err := PersistOverageSnapshot(id, snap); err != nil {
		logger.Warnf("[Overage] persist GET overage failed for %s: %v", account.Email, err)
	}
	h.pool.Reload()
	writeOverageSnapshot(w, snap)
}

func (h *Handler) apiSetAccountOverage(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	account := findAccountByID(id)
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}
	if body.Enabled && strings.EqualFold(account.OverageCapability, "NOT_OVERAGE_CAPABLE") {
		writeAdminError(w, http.StatusBadRequest, codeNotOverageCapable, "Account is not overage capable")
		return
	}

	if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
		writeAdminErrorDetail(w, http.StatusBadGateway, codeTokenRefreshFailed, err.Error(), err.Error())
		return
	}
	snap, err := SetOverageStatus(account, body.Enabled)
	if err != nil {
		writeAdminErr(w, http.StatusBadGateway, err, codeOverageFailed)
		return
	}
	if err := PersistOverageSnapshot(id, snap); err != nil {
		logger.Warnf("[Overage] persist SET overage failed for %s: %v", account.Email, err)
	}
	h.pool.Reload()
	writeOverageSnapshot(w, snap)
}

func findAccountByID(id string) *config.Account {
	accounts := config.GetAccounts()
	for i := range accounts {
		if accounts[i].ID == id {
			return &accounts[i]
		}
	}
	return nil
}

func writeOverageSnapshot(w http.ResponseWriter, snap *OverageSnapshot) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":           true,
		"overageStatus":     snap.Status,
		"overageCapability": snap.Capability,
		"subscriptionTitle": snap.SubscriptionTitle,
		"overageCap":        snap.OverageCap,
		"overageRate":       snap.OverageRate,
		"currentOverages":   snap.CurrentOverages,
		"overageCheckedAt":  snap.CheckedAt,
	})
}

func (h *Handler) apiBatchAccounts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs    []string `json:"ids"`
		Action string   `json:"action"`
		Tag    string   `json:"tag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if len(req.IDs) == 0 {
		writeAdminError(w, http.StatusBadRequest, codeNoAccountIDs, "No account IDs provided")
		return
	}

	switch req.Action {
	case "enable", "disable":
		h.batchSetEnabled(w, req.IDs, req.Action == "enable")
	case "refresh":
		h.batchRefresh(w, r, req.IDs)
	case "refreshModels":
		h.batchRefreshModels(w, req.IDs)
	case "delete":
		h.batchDelete(w, req.IDs)
	case "addTag", "removeTag":
		h.batchTags(w, req.IDs, req.Action == "addTag", req.Tag)
	default:
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid action: " + req.Action})
	}
}

// accountResult is one account's outcome in a batch or sweep response. Code and
// Detail are Error's admin API code and upstream part, when it has one.
type accountResult struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Code   string `json:"code,omitempty"`
	Detail string `json:"detail,omitempty"`
	Status string `json:"status,omitempty"`
}

const (
	// accountStatusNotFound marks a requested ID with no stored account.
	accountStatusNotFound = "not_found"
	// accountStatusSuspended marks an account the refresh found suspended and marked as such.
	accountStatusSuspended = "suspended"
)

func notFoundResult(id string) accountResult {
	return accountResult{ID: id, Error: "Account not found", Code: codeAccountNotFound, Status: accountStatusNotFound}
}

func countResults(results []accountResult) (ok, failed int) {
	for _, res := range results {
		if res.OK {
			ok++
		} else {
			failed++
		}
	}
	return ok, failed
}

// matchAccounts returns the stored accounts for ids in request order, without
// duplicates, and a slot index per account into a results slice that has one
// entry per distinct requested id. Unknown ids already hold a not_found result.
func matchAccounts(ids []string) ([]config.Account, []int, []accountResult) {
	byID := make(map[string]config.Account)
	for _, a := range config.GetAccounts() {
		byID[a.ID] = a
	}
	seen := make(map[string]bool, len(ids))
	var matched []config.Account
	var slots []int
	results := make([]accountResult, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		account, ok := byID[id]
		if !ok {
			results = append(results, notFoundResult(id))
			continue
		}
		matched = append(matched, account)
		slots = append(slots, len(results))
		results = append(results, accountResult{ID: id})
	}
	return matched, slots, results
}

func (h *Handler) batchSetEnabled(w http.ResponseWriter, ids []string, enabled bool) {
	matched, slots, results := matchAccounts(ids)
	var toRefreshModels []config.Account
	for i, a := range matched {
		wasEnabled := a.Enabled
		a.Enabled = enabled
		if enabled {
			if a.BanStatus != "" && a.BanStatus != "ACTIVE" {
				a.BanStatus = "ACTIVE"
				a.BanReason = ""
				a.BanTime = 0
			}
			a.Silent = false
			a.SilentReason = ""
			a.SilentTime = 0
		} else {
			keepOffForAdmin(&a)
		}
		if err := config.UpdateAccount(a.ID, a); err != nil {
			results[slots[i]].fail(err)
			continue
		}
		results[slots[i]].OK = true
		if enabled && !wasEnabled && a.AccessToken != "" {
			toRefreshModels = append(toRefreshModels, a)
		}
	}
	h.pool.Reload()

	for _, acc := range toRefreshModels {
		go func(a config.Account) {
			if err := h.fetchAndCacheAccountModels(&a); err != nil {
				logger.Warnf("[ModelsCache] Auto-refresh failed for batch-enabled account %s: %v", a.Email, err)
			}
		}(acc)
	}
	count, failed := countResults(results)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   count,
		"failed":  failed,
		"results": results,
	})
}

func (h *Handler) batchRefresh(w http.ResponseWriter, r *http.Request, ids []string) {
	matched, slots, results := matchAccounts(ids)
	//! Concurrent like the background sweep: dozens of accounts one at a time outlast a reverse proxy's timeout.
	forEachAccount(matched, backgroundRefreshWorkers, func(i int, account *config.Account) {
		res := &results[slots[i]]
		_, suspended, err := h.refreshAccountNow(r.Context(), account)
		switch {
		case err != nil:
			res.fail(err)
		case suspended:
			res.OK = true
			res.Status = accountStatusSuspended
		default:
			res.OK = true
		}
	})
	h.pool.Reload()

	refreshed, failed, suspended := 0, 0, 0
	for _, res := range results {
		switch {
		case !res.OK:
			failed++
		case res.Status == accountStatusSuspended:
			suspended++
		default:
			refreshed++
		}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"refreshed": refreshed,
		"suspended": suspended,
		"failed":    failed,
		"results":   results,
	})
}

func (h *Handler) batchRefreshModels(w http.ResponseWriter, ids []string) {
	matched, slots, results := matchAccounts(ids)
	forEachAccount(matched, backgroundRefreshWorkers, func(i int, account *config.Account) {
		h.useLatestToken(account)
		res := &results[slots[i]]
		if err := h.fetchAndCacheAccountModels(account); err != nil {
			res.fail(err)
			return
		}
		res.OK = true
	})
	refreshed, failed := countResults(results)
	h.modelsCacheMu.RLock()
	models := len(h.cachedModels)
	h.modelsCacheMu.RUnlock()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"refreshed": refreshed,
		"failed":    failed,
		"models":    models,
		"results":   results,
	})
}

func (h *Handler) batchDelete(w http.ResponseWriter, ids []string) {
	matched, slots, results := matchAccounts(ids)
	for i, a := range matched {
		if err := config.DeleteAccount(a.ID); err != nil {
			results[slots[i]].fail(err)
			continue
		}
		results[slots[i]].OK = true
	}
	h.pool.Reload()
	deleted, failed := countResults(results)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"deleted": deleted,
		"failed":  failed,
		"results": results,
	})
}

func (h *Handler) apiStartIamSso(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StartUrl string `json:"startUrl"`
		Region   string `json:"region"`

		ReloginAccountID string `json:"reloginAccountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	if req.StartUrl == "" {
		writeAdminError(w, http.StatusBadRequest, codeStartURLRequired, "startUrl is required")
		return
	}
	region, err := config.NormalizeAWSRegion(req.Region)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}

	if req.ReloginAccountID != "" && !reloginTargetOK(w, req.ReloginAccountID) {
		return
	}

	sessionID, authorizeUrl, expiresIn, err := auth.StartIamSsoLogin(req.StartUrl, region)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}

	response := map[string]interface{}{
		"sessionId":    sessionID,
		"authorizeUrl": authorizeUrl,
		"expiresIn":    expiresIn,
	}
	if req.ReloginAccountID != "" {
		reloginSessions.bind(sessionID, req.ReloginAccountID)
		response["reloginAccountId"] = req.ReloginAccountID
	}
	json.NewEncoder(w).Encode(response)
}

func (h *Handler) apiCompleteIamSso(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID   string `json:"sessionId"`
		CallbackUrl string `json:"callbackUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	accessToken, refreshToken, clientID, clientSecret, region, expiresIn, err := auth.CompleteIamSsoLogin(req.SessionID, req.CallbackUrl)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}

	email, userID, _ := auth.GetUserInfo(accessToken)

	account := config.Account{
		ID:           auth.GenerateAccountID(),
		Email:        email,
		UserId:       userID,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthMethod:   "idc",
		Region:       region,
		ExpiresAt:    time.Now().Unix() + int64(expiresIn),
		Enabled:      true,
		MachineId:    config.GenerateMachineId(),
	}

	if target := reloginSessions.target(req.SessionID); target != "" {
		reloginSessions.forget(req.SessionID)
		account.UserId = userID
		h.writeRelogin(w, r, target, account, nil)
		return
	}

	stored, updated, err := config.UpsertAccount(account)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"account": accountSavedRef(stored, updated),
	})
}

func (h *Handler) apiStartBuilderIdLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Region string `json:"region"`

		ReloginAccountID string `json:"reloginAccountId"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	region, err := config.NormalizeAWSRegion(req.Region)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	if req.ReloginAccountID != "" && !reloginTargetOK(w, req.ReloginAccountID) {
		return
	}

	session, err := auth.StartBuilderIdLogin(region)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}

	response := map[string]interface{}{
		"sessionId":       session.ID,
		"userCode":        session.UserCode,
		"verificationUri": session.VerificationUri,
		"interval":        session.Interval,
	}
	if req.ReloginAccountID != "" {
		reloginSessions.bind(session.ID, req.ReloginAccountID)
		response["reloginAccountId"] = req.ReloginAccountID
	}
	json.NewEncoder(w).Encode(response)
}

func (h *Handler) apiPollBuilderIdAuth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	accessToken, refreshToken, clientID, clientSecret, region, expiresIn, status, err := auth.PollBuilderIdAuth(req.SessionID)
	if err != nil {
		body := adminErrorBody(err, "")
		body["success"] = false
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(body)
		return
	}

	if status == "pending" || status == "slow_down" {

		interval := 5
		if session := auth.GetBuilderIdSession(req.SessionID); session != nil {
			interval = session.Interval
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":   true,
			"completed": false,
			"status":    status,
			"interval":  interval,
		})
		return
	}

	email, userID, _ := auth.GetUserInfo(accessToken)

	account := config.Account{
		ID:           auth.GenerateAccountID(),
		Email:        email,
		UserId:       userID,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthMethod:   "idc",
		Provider:     "BuilderId",
		Region:       region,
		ExpiresAt:    time.Now().Unix() + int64(expiresIn),
		Enabled:      true,
		MachineId:    config.GenerateMachineId(),
	}

	if target := reloginSessions.target(req.SessionID); target != "" {
		reloginSessions.forget(req.SessionID)
		account.UserId = userID
		h.writeRelogin(w, r, target, account, map[string]interface{}{"completed": true})
		return
	}

	stored, updated, err := config.UpsertAccount(account)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"completed": true,
		"account":   accountSavedRef(stored, updated),
	})
}

func (h *Handler) apiImportSsoToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BearerToken string `json:"bearerToken"`
		Region      string `json:"region"`

		ReloginAccountID string `json:"reloginAccountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if req.ReloginAccountID != "" && !reloginTargetOK(w, req.ReloginAccountID) {
		return
	}

	if req.BearerToken == "" {
		writeAdminError(w, http.StatusBadRequest, codeBearerTokenRequired, "bearerToken is required")
		return
	}
	region, err := config.NormalizeAWSRegion(req.Region)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	req.Region = region

	tokens := strings.Split(strings.TrimSpace(req.BearerToken), "\n")
	if req.ReloginAccountID != "" && !reloginSingleCredential(w, tokens) {
		return
	}
	var imported []map[string]interface{}
	var errors []string

	for _, token := range tokens {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}

		accessToken, refreshToken, clientID, clientSecret, expiresIn, err := auth.ImportFromSsoToken(token, req.Region)
		if err != nil {
			errors = append(errors, err.Error())
			continue
		}

		email, userID, _ := auth.GetUserInfo(accessToken)

		account := config.Account{
			ID:           auth.GenerateAccountID(),
			Email:        email,
			UserId:       userID,
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			ClientID:     clientID,
			ClientSecret: clientSecret,
			AuthMethod:   "idc",
			Region:       req.Region,
			ExpiresAt:    time.Now().Unix() + int64(expiresIn),
			Enabled:      true,
			MachineId:    config.GenerateMachineId(),
		}

		if req.ReloginAccountID != "" {
			account.UserId = userID
			h.writeRelogin(w, r, req.ReloginAccountID, account, nil)
			return
		}

		stored, updated, err := config.UpsertAccount(account)
		if err != nil {
			errors = append(errors, err.Error())
			continue
		}

		imported = append(imported, accountSavedRef(stored, updated))
	}

	h.pool.Reload()

	if len(imported) == 0 && len(errors) > 0 {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   strings.Join(errors, "; "),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"accounts": imported,
		"errors":   errors,
	})
}

func (h *Handler) apiImportCredentials(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		KiroApiKey   string `json:"kiroApiKey"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
		AuthMethod   string `json:"authMethod"`
		Provider     string `json:"provider"`
		Region       string `json:"region"`
		Email        string `json:"email"`
		Nickname     string `json:"nickname"`
		UserID       string `json:"userId"`
		ProfileArn   string `json:"profileArn"`

		Notes string   `json:"notes"`
		Tags  []string `json:"tags"`

		TokenEndpoint string `json:"tokenEndpoint"`
		IssuerURL     string `json:"issuerUrl"`
		Scopes        string `json:"scopes"`

		ReloginAccountID string `json:"reloginAccountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if req.ReloginAccountID != "" && !reloginTargetOK(w, req.ReloginAccountID) {
		return
	}

	req.RefreshToken = strings.TrimSpace(req.RefreshToken)
	req.AccessToken = strings.TrimSpace(req.AccessToken)
	req.KiroApiKey = strings.TrimSpace(req.KiroApiKey)
	methodHint := strings.ToLower(strings.TrimSpace(req.AuthMethod))
	//! A bare ksk_ accessToken with no refresh token is an API key pasted into the token field.
	if req.KiroApiKey == "" && req.RefreshToken == "" &&
		(methodHint == config.AuthMethodAPIKey || methodHint == "apikey" || config.LooksLikeKiroAPIKey(req.AccessToken)) {
		req.KiroApiKey = req.AccessToken
	}
	if req.KiroApiKey != "" {
		h.importKiroAPIKeyAccountFor(w, r, req.ReloginAccountID, config.Account{
			ID:         auth.GenerateAccountID(),
			Email:      strings.TrimSpace(req.Email),
			Nickname:   strings.TrimSpace(req.Nickname),
			Notes:      req.Notes,
			Tags:       req.Tags,
			KiroApiKey: req.KiroApiKey,
			AuthMethod: config.AuthMethodAPIKey,
			Provider:   strings.TrimSpace(req.Provider),
			Region:     strings.TrimSpace(req.Region),
			Enabled:    true,
		})
		return
	}

	if req.RefreshToken == "" {
		writeAdminError(w, http.StatusBadRequest, codeRefreshTokenRequired, "refreshToken or kiroApiKey is required")
		return
	}
	if req.ReloginAccountID != "" {
		if owner := reloginTokenOwner(req.ReloginAccountID, req.RefreshToken); owner != nil {
			writeReloginOtherAccount(w, req.ReloginAccountID, *owner, false)
			return
		}
	}

	region, err := config.NormalizeAWSRegion(req.Region)
	if err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	req.Region = region
	switch {
	case methodHint == "idc" || methodHint == "builderid" || methodHint == "enterprise":
		req.AuthMethod = "idc"
	case methodHint == "social" || methodHint == "google" || methodHint == "github":
		req.AuthMethod = "social"
	case isMicrosoftImport(methodHint, req.Provider, req.TokenEndpoint, req.IssuerURL, req.UserID, req.ClientID, req.AccessToken):
		req.AuthMethod = auth.MicrosoftSSOAuthMethod
	case methodHint == "" && req.ClientID != "":
		req.AuthMethod = "idc"
	case req.ClientID != "" && req.ClientSecret != "":
		req.AuthMethod = "idc"
	default:
		req.AuthMethod = "social"
	}

	var profileArn string
	if req.ProfileArn != "" {
		canonical, _, ok := parseKiroProfileArn(req.ProfileArn)
		if !ok {
			writeAdminError(w, http.StatusBadRequest, codeProfileArnInvalid, "profileArn is invalid")
			return
		}
		profileArn = canonical
	}

	tempAccount := &config.Account{
		RefreshToken: req.RefreshToken,
		ClientID:     strings.TrimSpace(req.ClientID),
		ClientSecret: req.ClientSecret,
		AuthMethod:   req.AuthMethod,
		Region:       req.Region,
	}
	if config.IsExternalIdpAccount(tempAccount) {
		if err := completeMicrosoftImport(tempAccount, req.UserID, req.AccessToken, req.TokenEndpoint, req.IssuerURL, req.Scopes); err != nil {
			writeAdminErr(w, http.StatusBadRequest, err, codeMicrosoftCredential)
			return
		}
		req.ClientID = tempAccount.ClientID
		req.ClientSecret = ""
		req.Provider = auth.MicrosoftSSOProvider
	}
	accessToken, newRefreshToken, expiresAt, newProfileArn, err := auth.RefreshToken(tempAccount)
	if err != nil {
		writeAdminErrorDetail(w, http.StatusBadRequest, codeTokenRefreshFailed, "Token refresh failed: "+err.Error(), err.Error())
		return
	}
	if newRefreshToken != "" {
		req.RefreshToken = newRefreshToken
	}
	if profileArn == "" {
		profileArn = newProfileArn
	}

	var email, userID, kiroUserID string
	if config.IsExternalIdpAccount(tempAccount) {
		email, userID = auth.ExternalIdpTokenIdentity(accessToken, tempAccount.IssuerURL)
		if profileArn != "" {
			//! Same trust boundary as interactive login: only a profile Kiro lists for this token may be pinned.
			probe := *tempAccount
			probe.AccessToken = accessToken
			if err := verifyOfferedProfile(r.Context(), &probe, profileArn); err != nil {
				writeAdminErr(w, http.StatusBadRequest, err, "")
				return
			}
		}
	} else {
		email, kiroUserID, _ = auth.GetUserInfo(accessToken)
		userID = kiroUserID
	}
	if email == "" {
		email = strings.TrimSpace(req.Email)
	}
	if userID == "" {
		userID = strings.TrimSpace(req.UserID)
	}

	account := config.Account{
		ID:            auth.GenerateAccountID(),
		Email:         email,
		UserId:        userID,
		Nickname:      strings.TrimSpace(req.Nickname),
		Notes:         req.Notes,
		Tags:          req.Tags,
		AccessToken:   accessToken,
		RefreshToken:  req.RefreshToken,
		ClientID:      req.ClientID,
		ClientSecret:  req.ClientSecret,
		AuthMethod:    req.AuthMethod,
		Provider:      req.Provider,
		Region:        req.Region,
		ExpiresAt:     expiresAt,
		Enabled:       true,
		MachineId:     config.GenerateMachineId(),
		ProfileArn:    profileArn,
		TokenEndpoint: tempAccount.TokenEndpoint,
		IssuerURL:     tempAccount.IssuerURL,
		Scopes:        tempAccount.Scopes,
	}

	if req.ReloginAccountID != "" {
		//! The lookup's user id, not a pasted one, is what the identity check compares.
		if kiroUserID != "" {
			account.UserId = kiroUserID
		}
		h.writeRelogin(w, r, req.ReloginAccountID, account, nil)
		return
	}

	var stored config.Account
	var updated bool
	if config.IsExternalIdpAccount(&account) {
		//! Same lock and duplicate check as interactive login, so an import cannot add a second copy of one Entra user.
		microsoftSSOFlows.mu.Lock()
		stored, updated, err = microsoftSSOFlows.saveAccountLocked("", account)
		microsoftSSOFlows.mu.Unlock()
		if err != nil {
			writeMicrosoftAddError(w, err)
			return
		}
	} else if stored, updated, err = config.UpsertAccount(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"account": accountSavedRef(stored, updated),
	})
}

func (h *Handler) importKiroAPIKeyAccount(w http.ResponseWriter, account config.Account) {
	//! No OAuth refresh and no profile lookup: the key is the credential, and it never expires.
	if err := config.NormalizeAPIKeyAccount(&account); err != nil {
		writeAdminErr(w, http.StatusBadRequest, err, "")
		return
	}
	stored, updated, err := config.UpsertAccount(account)
	if err != nil {
		writeAdminErr(w, addAccountErrorStatus(err), err, "")
		return
	}

	h.pool.Reload()
	go func(acc config.Account) {
		if err := h.fetchAndCacheAccountModels(&acc); err != nil {
			logger.Warnf("[ModelsCache] Auto-refresh failed for new API key account %s: %v", acc.Email, err)
		}
	}(stored)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"account": accountSavedRef(stored, updated),
	})
}

func addAccountErrorStatus(err error) int {
	switch {
	case errors.Is(err, config.ErrDuplicateKiroAPIKey):
		return http.StatusConflict
	case errors.Is(err, config.ErrUnsupportedKiroAPIKeyRegion), errors.Is(err, config.ErrInvalidKiroRegion),
		errors.Is(err, config.ErrEmptyKiroAPIKey), errors.Is(err, config.ErrInvalidKiroAPIKey):
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func (h *Handler) apiGetStatus(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(h.statusPayload(true))
}

func (h *Handler) apiGetSettings(w http.ResponseWriter, _ *http.Request) {
	logLevel, logLevelFromEnv := currentLogLevel()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"requireApiKey":          config.IsApiKeyRequired(),
		"port":                   config.GetPort(),
		"host":                   config.GetHost(),
		"allowOverUsage":         config.GetAllowOverUsage(),
		"lenientStreamIntegrity": config.GetLenientStreamIntegrity(),
		"sessionAffinity":        config.GetSessionAffinity(),
		"routingMode":            config.GetRoutingMode(),
		"accountRpmLimit":        config.GetAccountRPMLimit(),
		"autoContinue":           config.GetAutoContinue(),
		"autoContinueMax":        config.GetAutoContinueMax(),
		"structuredToolHistory":  config.GetStructuredToolHistory(),

		"usageRefreshIntervalMinutes": config.GetUsageRefreshIntervalMinutes(),

		"imageResize":             config.GetImageResize(),
		"imageResizeMaxDimension": config.GetImageResizeMaxDimension(),
		"imageResizeMaxKB":        config.GetImageResizeMaxKB(),

		"logLevel":        logLevel,
		"logLevelFromEnv": logLevelFromEnv,
	})
}

func (h *Handler) apiGetPromptFilter(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(config.GetPromptFilterConfig())
}

func (h *Handler) apiUpdatePromptFilter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FilterClaudeCode      *bool                      `json:"filterClaudeCode,omitempty"`
		FilterEnvNoise        *bool                      `json:"filterEnvNoise,omitempty"`
		FilterStripBoundaries *bool                      `json:"filterStripBoundaries,omitempty"`
		Rules                 *[]config.PromptFilterRule `json:"rules,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	current := config.GetPromptFilterConfig()
	fcc := current.FilterClaudeCode
	fen := current.FilterEnvNoise
	fsb := current.FilterStripBoundaries
	rules := current.Rules
	if req.FilterClaudeCode != nil {
		fcc = *req.FilterClaudeCode
	}
	if req.FilterEnvNoise != nil {
		fen = *req.FilterEnvNoise
	}
	if req.FilterStripBoundaries != nil {
		fsb = *req.FilterStripBoundaries
	}
	if req.Rules != nil {
		rules = *req.Rules
	}
	if err := config.UpdatePromptFilterConfig(fcc, fen, fsb, rules); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetModelMappings(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mappings": config.GetModelMappings(),
		"defaults": config.DefaultModelMappings(),
	})
}

func (h *Handler) apiUpdateModelMappings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mappings []config.ModelMappingRule `json:"mappings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if err := config.UpdateModelMappings(req.Mappings); err != nil {
		var mappingErr *config.ModelMappingError
		if errors.As(err, &mappingErr) {
			body := adminErrorBody(err, "")
			body["index"] = mappingErr.Index
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(body)
			return
		}
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RequireApiKey          *bool  `json:"requireApiKey,omitempty"`
		Password               string `json:"password,omitempty"`
		AllowOverUsage         *bool  `json:"allowOverUsage,omitempty"`
		LenientStreamIntegrity *bool  `json:"lenientStreamIntegrity,omitempty"`
		SessionAffinity        *bool  `json:"sessionAffinity,omitempty"`
		AccountRPMLimit        *int   `json:"accountRpmLimit,omitempty"`
		AutoContinue           *bool  `json:"autoContinue,omitempty"`
		AutoContinueMax        *int   `json:"autoContinueMax,omitempty"`
		StructuredToolHistory  *bool  `json:"structuredToolHistory,omitempty"`

		UsageRefreshIntervalMinutes *int `json:"usageRefreshIntervalMinutes,omitempty"`
		routingSettingsPatch

		ImageResize             *bool `json:"imageResize,omitempty"`
		ImageResizeMaxDimension *int  `json:"imageResizeMaxDimension,omitempty"`
		ImageResizeMaxKB        *int  `json:"imageResizeMaxKB,omitempty"`

		LogLevel *string `json:"logLevel,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	logLevel, ok := parseLogLevelPatch(req.LogLevel)
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeLogLevelInvalid, "logLevel must be one of: debug, info, warn, error")
		return
	}

	if req.AutoContinueMax != nil && (*req.AutoContinueMax < 1 || *req.AutoContinueMax > config.MaxAutoContinueMax) {
		writeAdminError(w, http.StatusBadRequest, codeAutoContinueMaxRange, fmt.Sprintf("autoContinueMax must be between 1 and %d", config.MaxAutoContinueMax))
		return
	}
	if !validateUsageRefreshInterval(w, req.UsageRefreshIntervalMinutes) {
		return
	}
	if rejectInvalidRoutingMode(w, req.RoutingMode) {
		return
	}

	if code, msg := validateImageResizePatch(req.ImageResizeMaxDimension, req.ImageResizeMaxKB); code != "" {
		writeAdminError(w, http.StatusBadRequest, code, msg)
		return
	}
	if !validAccountRPMLimit(w, req.AccountRPMLimit) {
		return
	}

	if req.Password != "" && utf8.RuneCountInString(req.Password) < config.MinAdminPasswordLength {
		writeAdminError(w, http.StatusBadRequest, codePasswordTooShort, fmt.Sprintf("Password must be at least %d characters", config.MinAdminPasswordLength))
		return
	}

	//! The server, not only the UI, refuses a state where no client can authenticate.
	if err := config.UpdateSettingsPatchGuarded(req.RequireApiKey, req.Password); err != nil {
		if errors.Is(err, config.ErrApiKeyLockout) {
			writeAPIKeyLockout(w)
			return
		}
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	//! A password change must actually lock out whoever held the old one.
	if req.Password != "" {
		h.adminSessions.RevokeAll()
	}

	if req.AllowOverUsage != nil {
		if err := config.UpdateAllowOverUsage(*req.AllowOverUsage); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		h.pool.Reload()
	}

	if req.LenientStreamIntegrity != nil {
		if err := config.UpdateLenientStreamIntegrity(*req.LenientStreamIntegrity); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if req.SessionAffinity != nil {
		if err := config.UpdateSessionAffinity(*req.SessionAffinity); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if !applyRoutingMode(w, req.RoutingMode) {
		return
	}

	//! The pool reads the limit on every pick, so it applies without a Reload.
	if req.AccountRPMLimit != nil {
		if err := config.UpdateAccountRPMLimit(*req.AccountRPMLimit); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if req.AutoContinue != nil {
		if err := config.UpdateAutoContinue(*req.AutoContinue); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if req.AutoContinueMax != nil {
		if err := config.UpdateAutoContinueMax(*req.AutoContinueMax); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if req.StructuredToolHistory != nil {
		if err := config.UpdateStructuredToolHistory(*req.StructuredToolHistory); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if !h.applyUsageRefreshInterval(w, req.UsageRefreshIntervalMinutes) {
		return
	}

	if err := applyImageResizePatch(req.ImageResize, req.ImageResizeMaxDimension, req.ImageResizeMaxKB); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	if err := applyLogLevel(logLevel); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetStats(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(h.statusPayload(false))
}

func (h *Handler) apiResetStats(w http.ResponseWriter, _ *http.Request) {
	config.UpdateStats(0, 0, 0, 0, 0)
	getObserveStore().Reset()
	if err := resetRequestLog(); err != nil {
		logger.Warnf("[Stats] Failed to clear the request log: %v", err)
	}
	publishEvent(eventStatsReset, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGenerateMachineId(w http.ResponseWriter, _ *http.Request) {
	machineId := config.GenerateMachineId()
	json.NewEncoder(w).Encode(map[string]string{"machineId": machineId})
}

func (h *Handler) apiTestAccount(w http.ResponseWriter, r *http.Request, id string) {
	accounts := config.GetAccounts()
	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	if err := h.ensureValidToken(account); err != nil {
		writeAdminErrorDetail(w, http.StatusInternalServerError, codeTokenRefreshFailed, "Token refresh failed: "+err.Error(), err.Error())
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Model == "" {
		req.Model = "claude-sonnet-5"
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := ParseModelAndThinking(req.Model, thinkingCfg.Suffix)

	openaiReq := &OpenAIRequest{
		Model:     actualModel,
		Messages:  []OpenAIMessage{{Role: "user", Content: "say ok"}},
		MaxTokens: 5,
		Stream:    false,
	}
	kiroPayload := OpenAIToKiro(openaiReq, thinking)

	var content, reasoning, stopReason string
	var inputTokens, outputTokens int
	var credits, contextUsage float64
	callback := &KiroStreamCallback{
		OnText: func(text string, isThinking bool) {
			if isThinking {
				reasoning += text
				return
			}
			content += text
		},
		OnToolUse:      func(tu KiroToolUse) {},
		OnComplete:     func(inTok, outTok int) { inputTokens, outputTokens = inTok, outTok },
		OnError:        func(err error) {},
		OnCredits:      func(c float64) { credits = c },
		OnContextUsage: func(pct float64) { contextUsage = pct },
		//! An account that answers but reports no stop reason is the IdC signature
		//! behind Kiro-Go #147/#158. Without this the test cannot tell that apart
		//! from a cleanly completed turn, so report what the stream actually proved.
		OnStopReason: func(reason string) { stopReason = reason },
	}

	err := CallKiroAPIContext(r.Context(), account, kiroPayload, callback)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":      true,
		"reply":        content,
		"model":        req.Model,
		"stopReason":   stopReason,
		"reasoning":    reasoning,
		"inputTokens":  inputTokens,
		"outputTokens": outputTokens,
		"credits":      credits,
		"contextUsage": contextUsage,
	})
}

func (h *Handler) apiRefreshAccount(w http.ResponseWriter, r *http.Request, id string) {
	account := findAccountByID(id)
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	defer h.pool.Reload()
	info, suspended, err := h.refreshAccountNow(r.Context(), account)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	if suspended {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"message": "Account status updated",
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"info":    info,
	})
}

// refreshAccountNow reloads one stored account's subscription and usage, for
// the row refresh and the batch refresh alike. It refreshes the token first
// when it is about to expire and once more after an auth error. A suspended
// account is marked as such and reported with suspended=true and no info.
func (h *Handler) refreshAccountNow(ctx context.Context, account *config.Account) (*config.AccountInfo, bool, error) {
	refreshTokenIfNeeded := func() error {
		if account.RefreshToken == "" {
			return nil
		}
		return refreshStoredAccount(ctx, account, true)
	}
	isSuspended := func(err error) bool {
		msg := err.Error()
		return strings.Contains(msg, "TEMPORARILY_SUSPENDED") || strings.Contains(strings.ToLower(msg), "account suspended")
	}

	if account.ExpiresAt > 0 && time.Now().Unix() > account.ExpiresAt-tokenRefreshSkewSeconds {
		if err := refreshTokenIfNeeded(); err != nil {
			return nil, false, &tokenRefreshError{prefix: "token refresh failed", err: err}
		}
	}

	info, err := refreshAccountInfo(account, false)
	if err != nil {
		if isSuspended(err) {
			h.handleBackgroundAccountFailure(account, err)
			return nil, true, nil
		}
		errMsg := err.Error()
		if strings.Contains(errMsg, "403") || strings.Contains(errMsg, "401") || strings.Contains(errMsg, "invalid") || strings.Contains(errMsg, "expired") {
			if refreshErr := refreshTokenIfNeeded(); refreshErr == nil {
				info, err = refreshAccountInfo(account, false)
				if err != nil && isSuspended(err) {
					h.handleBackgroundAccountFailure(account, err)
					return nil, true, nil
				}
			}
		}
		if err != nil {
			h.handleBackgroundAccountFailure(account, err)
			return nil, false, err
		}
	}

	if err := config.UpdateAccountInfo(account.ID, *info); err != nil {
		return nil, false, err
	}
	return info, false, nil
}

func (h *Handler) apiGetAccountFull(w http.ResponseWriter, _ *http.Request, id string) {
	accounts := config.GetAccounts()
	poolAccounts := h.pool.GetAllAccounts()

	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}

	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	statsMap := make(map[string]config.Account, len(poolAccounts))
	for _, a := range poolAccounts {
		statsMap[a.ID] = a
	}
	stats := accountStats(statsMap, *account)

	result := map[string]interface{}{
		"id":                account.ID,
		"email":             account.Email,
		"userId":            account.UserId,
		"nickname":          account.Nickname,
		"notes":             account.Notes,
		"tags":              tagsOrEmpty(account.Tags),
		"accessToken":       account.AccessToken,
		"refreshToken":      account.RefreshToken,
		"kiroApiKey":        account.KiroApiKey,
		"clientId":          account.ClientID,
		"clientSecret":      account.ClientSecret,
		"authMethod":        account.AuthMethod,
		"provider":          account.Provider,
		"region":            account.Region,
		"profileArn":        account.ProfileArn,
		"profileArnPinned":  account.ProfileArnPinned,
		"tokenEndpoint":     account.TokenEndpoint,
		"issuerUrl":         account.IssuerURL,
		"scopes":            account.Scopes,
		"expiresAt":         account.ExpiresAt,
		"machineId":         account.MachineId,
		"weight":            account.Weight,
		"priority":          account.Priority,
		"overageStatus":     account.OverageStatus,
		"overageCapability": account.OverageCapability,
		"overageCap":        account.OverageCap,
		"overageRate":       account.OverageRate,
		"currentOverages":   account.CurrentOverages,
		"overageCheckedAt":  account.OverageCheckedAt,
		"proxyURL":          account.ProxyURL,
		"enabled":           account.Enabled,
		"silent":            account.Silent,
		"silentReason":      account.SilentReason,
		"silentTime":        account.SilentTime,
		"banStatus":         account.BanStatus,
		"banReason":         account.BanReason,
		"banTime":           account.BanTime,
		"subscriptionType":  account.SubscriptionType,
		"subscriptionTitle": account.SubscriptionTitle,
		"daysRemaining":     account.DaysRemaining,
		"usageCurrent":      account.UsageCurrent,
		"usageLimit":        account.UsageLimit,
		"usagePercent":      account.UsagePercent,
		"nextResetDate":     account.NextResetDate,
		"lastRefresh":       account.LastRefresh,
		"trialUsageCurrent": account.TrialUsageCurrent,
		"trialUsageLimit":   account.TrialUsageLimit,
		"trialUsagePercent": account.TrialUsagePercent,
		"trialStatus":       account.TrialStatus,
		"trialExpiresAt":    account.TrialExpiresAt,
		"requestCount":      stats.RequestCount,
		"errorCount":        stats.ErrorCount,
		"totalTokens":       stats.TotalTokens,
		"totalCredits":      stats.TotalCredits,
		"lastUsed":          stats.LastUsed,
	}

	json.NewEncoder(w).Encode(result)
}

func (h *Handler) apiGetAccountModels(w http.ResponseWriter, r *http.Request, id string) {
	accounts := config.GetAccounts()
	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}

	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return
	}

	if err := h.ensureValidTokenContext(r.Context(), account); err != nil {
		writeAdminErrorDetail(w, http.StatusBadGateway, codeTokenRefreshFailed, err.Error(), err.Error())
		return
	}
	models, err := ListAvailableModels(account)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	modelIDs := make([]string, 0, len(models))
	for _, m := range models {
		modelIDs = append(modelIDs, m.ModelId)
	}
	h.pool.SetModelList(id, modelIDs)
	h.modelsCacheMu.Lock()
	h.cachedModels = mergeUniqueModels(h.cachedModels, models)
	publishNativeModels(h.cachedModels)
	h.modelsCacheTime = time.Now().Unix()
	h.modelsCacheMu.Unlock()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"models":  models,
	})
}

func (h *Handler) apiGetAccountModelsCached(w http.ResponseWriter, _ *http.Request, id string) {
	models := h.pool.GetModelList(id)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"models":  models,
	})
}

func (h *Handler) apiGetThinkingConfig(w http.ResponseWriter, _ *http.Request) {
	cfg := config.GetThinkingConfig()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"suffix":       cfg.Suffix,
		"openaiFormat": cfg.OpenAIFormat,
		"claudeFormat": cfg.ClaudeFormat,
	})
}

func (h *Handler) apiUpdateThinkingConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Suffix       string `json:"suffix"`
		OpenAIFormat string `json:"openaiFormat"`
		ClaudeFormat string `json:"claudeFormat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	validFormats := map[string]bool{"reasoning_content": true, "thinking": true, "think": true}
	if req.OpenAIFormat != "" && !validFormats[req.OpenAIFormat] {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid openaiFormat, must be: reasoning_content, thinking, or think"})
		return
	}
	if req.ClaudeFormat != "" && !validFormats[req.ClaudeFormat] {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid claudeFormat, must be: reasoning_content, thinking, or think"})
		return
	}

	if err := config.UpdateThinkingConfig(req.Suffix, req.OpenAIFormat, req.ClaudeFormat); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetEndpointConfig(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"preferredEndpoint": config.GetPreferredEndpoint(),
		"endpointFallback":  config.GetEndpointFallback(),
	})
}

func (h *Handler) apiUpdateEndpointConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PreferredEndpoint string `json:"preferredEndpoint"`
		EndpointFallback  *bool  `json:"endpointFallback"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	valid := map[string]bool{"auto": true, "kiro": true, "codewhisperer": true, "amazonq": true}
	if !valid[req.PreferredEndpoint] {
		writeAdminError(w, http.StatusBadRequest, codeInvalidEndpoint, "Invalid endpoint, must be: auto, kiro, codewhisperer, or amazonq")
		return
	}

	if err := config.UpdatePreferredEndpoint(req.PreferredEndpoint); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	if req.EndpointFallback != nil {
		config.UpdateEndpointFallback(*req.EndpointFallback)
	}

	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func applyProxyConfig(proxyURL string) {
	InitKiroHttpClient(proxyURL)
	auth.InitHttpClient(proxyURL)
}

func (h *Handler) apiGetProxy(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{
		"proxyURL": maskProxyURL(config.GetProxyURL()),
	})
}

func (h *Handler) apiUpdateProxy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProxyURL string `json:"proxyURL"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	if req.ProxyURL != "" {
		if !strings.HasPrefix(req.ProxyURL, "http://") &&
			!strings.HasPrefix(req.ProxyURL, "https://") &&
			!strings.HasPrefix(req.ProxyURL, "socks5://") &&
			!strings.HasPrefix(req.ProxyURL, "socks5h://") {
			writeAdminError(w, http.StatusBadRequest, codeProxyURLScheme, "proxyURL must start with http://, https://, socks5://, or socks5h://")
			return
		}
	}
	//! GET answers with the password masked; the mask sent back keeps the saved one.
	restored, err := restoreProxyPassword(req.ProxyURL, config.GetProxyURL())
	if err != nil {
		writeProxyURLError(w, err)
		return
	}
	req.ProxyURL = restored
	if err := proxypool.ValidateOutboundURL(req.ProxyURL); err != nil {
		writeProxyURLError(w, err)
		return
	}

	if err := config.UpdateProxySettings(req.ProxyURL); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	applyProxyConfig(req.ProxyURL)

	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetVersion(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{
		"version": config.Version,
	})
}

func (h *Handler) apiExportAccounts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {

		req.IDs = nil
	}

	accounts := config.GetAccounts()

	if len(req.IDs) > 0 {
		idSet := make(map[string]bool)
		for _, id := range req.IDs {
			idSet[id] = true
		}
		var filtered []config.Account
		for _, a := range accounts {
			if idSet[a.ID] {
				filtered = append(filtered, a)
			}
		}
		accounts = filtered
	}

	type ExportCredentials struct {
		AccessToken  string `json:"accessToken"`
		CsrfToken    string `json:"csrfToken"`
		RefreshToken string `json:"refreshToken"`
		KiroApiKey   string `json:"kiroApiKey,omitempty"`
		ClientID     string `json:"clientId,omitempty"`
		ClientSecret string `json:"clientSecret,omitempty"`
		Region       string `json:"region,omitempty"`
		ExpiresAt    int64  `json:"expiresAt"`
		AuthMethod   string `json:"authMethod,omitempty"`
		Provider     string `json:"provider,omitempty"`

		TokenEndpoint string `json:"tokenEndpoint,omitempty"`
		IssuerURL     string `json:"issuerUrl,omitempty"`
		Scopes        string `json:"scopes,omitempty"`
	}

	type ExportSubscription struct {
		Type  string `json:"type"`
		Title string `json:"title,omitempty"`
	}

	type ExportUsage struct {
		Current     float64 `json:"current"`
		Limit       float64 `json:"limit"`
		PercentUsed float64 `json:"percentUsed"`
		LastUpdated int64   `json:"lastUpdated"`
	}

	type ExportAccount struct {
		ID           string             `json:"id"`
		Email        string             `json:"email"`
		Nickname     string             `json:"nickname,omitempty"`
		Notes        string             `json:"notes,omitempty"`
		Idp          string             `json:"idp"`
		UserId       string             `json:"userId,omitempty"`
		ProfileArn   string             `json:"profileArn,omitempty"`
		MachineId    string             `json:"machineId,omitempty"`
		Credentials  ExportCredentials  `json:"credentials"`
		Subscription ExportSubscription `json:"subscription"`
		Usage        ExportUsage        `json:"usage"`
		Tags         []string           `json:"tags"`
		Status       string             `json:"status"`
		CreatedAt    int64              `json:"createdAt"`
		LastUsedAt   int64              `json:"lastUsedAt"`
	}

	type ExportData struct {
		Version    string          `json:"version"`
		ExportedAt int64           `json:"exportedAt"`
		Accounts   []ExportAccount `json:"accounts"`
		Groups     []interface{}   `json:"groups"`
		Tags       []interface{}   `json:"tags"`
	}

	exportAccounts := make([]ExportAccount, 0, len(accounts))
	for _, a := range accounts {

		idp := a.Provider
		if idp == "" {
			if a.AuthMethod == "social" {
				idp = "Google"
			} else if config.IsExternalIdpAccount(&a) {
				idp = auth.MicrosoftSSOProvider
			} else {
				idp = "BuilderId"
			}
		}

		authMethod := a.AuthMethod
		if authMethod == "idc" {
			authMethod = "IdC"
		}

		subType := "Free"
		rawType := strings.ToUpper(a.SubscriptionType)
		if strings.Contains(rawType, "PRO_PLUS") || strings.Contains(rawType, "PROPLUS") {
			subType = "Pro_Plus"
		} else if strings.Contains(rawType, "PRO") {
			subType = "Pro"
		} else if strings.Contains(rawType, "POWER") {
			subType = "Pro_Plus"
		}

		exportAccounts = append(exportAccounts, ExportAccount{
			ID:         a.ID,
			Email:      a.Email,
			Nickname:   a.Nickname,
			Notes:      a.Notes,
			Idp:        idp,
			UserId:     a.UserId,
			ProfileArn: a.ProfileArn,
			MachineId:  a.MachineId,
			Credentials: ExportCredentials{
				AccessToken:   a.AccessToken,
				CsrfToken:     "",
				RefreshToken:  a.RefreshToken,
				KiroApiKey:    a.KiroApiKey,
				ClientID:      a.ClientID,
				ClientSecret:  a.ClientSecret,
				Region:        a.Region,
				ExpiresAt:     a.ExpiresAt * 1000,
				AuthMethod:    authMethod,
				Provider:      a.Provider,
				TokenEndpoint: a.TokenEndpoint,
				IssuerURL:     a.IssuerURL,
				Scopes:        a.Scopes,
			},
			Subscription: ExportSubscription{
				Type:  subType,
				Title: a.SubscriptionTitle,
			},
			Usage: ExportUsage{
				Current:     a.UsageCurrent,
				Limit:       a.UsageLimit,
				PercentUsed: a.UsagePercent,
				LastUpdated: time.Now().UnixMilli(),
			},
			Tags:       tagsOrEmpty(a.Tags),
			Status:     "active",
			CreatedAt:  time.Now().UnixMilli(),
			LastUsedAt: time.Now().UnixMilli(),
		})
	}

	data := ExportData{
		Version:    config.Version,
		ExportedAt: time.Now().UnixMilli(),
		Accounts:   exportAccounts,
		Groups:     []interface{}{},
		Tags:       exportTagObjects(accounts),
	}

	json.NewEncoder(w).Encode(data)
}

func decompressRequestBody(r *http.Request) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	encodings := strings.Split(strings.ToLower(r.Header.Get("Content-Encoding")), ",")
	if len(encodings) > 3 {
		return fmt.Errorf("too many Content-Encoding layers")
	}
	for _, encoding := range encodings {
		switch strings.TrimSpace(encoding) {
		case "", "identity", "gzip", "x-gzip", "deflate", "zstd":
		default:
			return fmt.Errorf("unsupported Content-Encoding: %s", encoding)
		}
	}
	raw, err := readRequestBody(r.Body)
	_ = r.Body.Close()
	if err != nil {
		return err
	}
	//! The network read holds no slot, so slow uploads cannot starve others; only in-memory expansion is gated.
	if hasCompressionLayer(encodings) {
		select {
		case requestBodySlots <- struct{}{}:
			defer func() { <-requestBodySlots }()
		case <-r.Context().Done():
			return r.Context().Err()
		}
	}
	for i := len(encodings) - 1; i >= 0; i-- {
		switch strings.TrimSpace(encodings[i]) {
		case "", "identity":
			continue
		case "gzip", "x-gzip":
			reader, e := gzip.NewReader(bytes.NewReader(raw))
			if e != nil {
				return e
			}
			raw, err = readRequestBody(reader)
			reader.Close()
		case "deflate":
			reader, e := zlib.NewReader(bytes.NewReader(raw))
			if e != nil {
				return e
			}
			raw, err = readRequestBody(reader)
			reader.Close()
		case "zstd":
			reader, e := zstd.NewReader(bytes.NewReader(raw), zstd.WithDecoderMaxMemory(uint64(maxRequestBodyBytes)), zstd.WithDecoderConcurrency(1))
			if e != nil {
				return e
			}
			raw, err = readRequestBody(reader)
			reader.Close()
		}
		if err != nil {
			return err
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	r.ContentLength = int64(len(raw))
	r.Header.Del("Content-Encoding")
	r.Header.Del("Content-Length")
	return nil
}

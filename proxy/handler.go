package proxy

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
)

const tokenRefreshSkewSeconds int64 = 120

type Handler struct {
	pool *pool.AccountPool

	startTime      int64
	stopRefresh    chan struct{}
	stopStatsSaver chan struct{}

	cachedModels    []ModelInfo
	modelsCacheMu   sync.RWMutex
	modelsCacheTime int64
	promptCache     *promptCacheTracker
	tokenRefreshMu  sync.Mutex
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
	if len(req.Messages) == 0 {
		return "messages must not be empty"
	}
	if msg := validateClaudeThinkingConfig(req.Thinking, req.MaxTokens); msg != "" {
		return msg
	}

	hasUserContext := false
	lastRole := ""
	for _, msg := range req.Messages {
		role := strings.TrimSpace(msg.Role)
		if role == "" {
			continue
		}
		lastRole = role
		if role != "user" {
			continue
		}

		text, images, toolResults := extractClaudeUserContent(msg.Content)
		if normalizeUserContent(text, len(images) > 0) != "" || len(toolResults) > 0 {
			hasUserContext = true
		}
	}

	if lastRole == "assistant" {
		return "assistant-prefill final message is not supported; last message must be user"
	}
	if !hasUserContext {
		return "at least one non-empty user message is required"
	}
	return ""
}

func validateClaudeThinkingConfig(thinking *ClaudeThinkingConfig, maxTokens int) string {
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
		if maxTokens > 0 && thinking.BudgetTokens >= maxTokens {
			return "thinking.budget_tokens must be less than max_tokens"
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
	if display != "" && display != "summarized" && display != "omitted" {
		return "thinking.display must be one of: summarized, omitted"
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
	case "summarized":
		opts.Format = "thinking"
	case "omitted":
		opts.Format = "thinking"
		opts.OmitDisplay = true
	}

	return opts
}

func validateOpenAIRequestShape(req *OpenAIRequest) string {
	if len(req.Messages) == 0 {
		return "messages must not be empty"
	}

	hasNonSystem := false
	hasUserContext := false
	lastRole := ""
	for _, msg := range req.Messages {
		role := strings.TrimSpace(msg.Role)
		if role == "" {
			continue
		}
		if role != "system" {
			hasNonSystem = true
			lastRole = role
		}

		if role != "user" {
			continue
		}
		text, images := extractOpenAIUserContent(msg.Content)
		if normalizeUserContent(text, len(images) > 0) != "" {
			hasUserContext = true
		}
	}

	if !hasNonSystem {
		return "at least one non-system message is required"
	}
	if lastRole == "assistant" {
		return "assistant-prefill final message is not supported; last message must be user or tool"
	}
	if !hasUserContext {
		return "at least one non-empty user message is required"
	}
	return ""
}

func NewHandler() *Handler {

	applyProxyConfig(config.GetProxyURL())

	h := &Handler{
		pool:           pool.GetPool(),
		startTime:      time.Now().Unix(),
		stopRefresh:    make(chan struct{}),
		stopStatsSaver: make(chan struct{}),
		promptCache:    newPromptCacheTracker(defaultPromptCacheTTL),
	}

	go h.backgroundRefresh()

	go h.backgroundObserveTick()

	if err := getObserveStore().LoadFromDB(); err != nil {
		logger.Warnf("[Observe] Failed to load: %v", err)
	}

	go h.backgroundBackupScheduler()
	go h.backgroundCooldownSaver()
	return h
}

func (h *Handler) backgroundRefresh() {
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()

	time.Sleep(10 * time.Second)
	h.refreshModelsCache()
	h.refreshAllAccounts()

	for {
		select {
		case <-ticker.C:
			h.refreshModelsCache()
			h.refreshAllAccounts()
		case <-h.stopRefresh:
			return
		}
	}
}

func (h *Handler) refreshAllAccounts() {
	accounts := config.GetAccounts()
	now := time.Now().Unix()
	const refreshInterval = 30 * 60

	for i := range accounts {
		account := &accounts[i]
		if !account.Enabled || account.AccessToken == "" {
			continue
		}
		if account.Silent || (account.BanStatus != "" && account.BanStatus != "ACTIVE") {
			continue
		}

		if account.ExpiresAt > 0 && time.Now().Unix() > account.ExpiresAt-tokenRefreshSkewSeconds {
			newAccessToken, newRefreshToken, newExpiresAt, profileArn, err := auth.RefreshToken(account)
			if err != nil {
				logger.Warnf("[BackgroundRefresh] Token refresh failed for %s: %v", account.Email, err)
			} else {
				account.AccessToken = newAccessToken
				if newRefreshToken != "" {
					account.RefreshToken = newRefreshToken
				}
				account.ExpiresAt = newExpiresAt
				config.UpdateAccountToken(account.ID, newAccessToken, newRefreshToken, newExpiresAt)
				h.pool.UpdateToken(account.ID, newAccessToken, newRefreshToken, newExpiresAt)
				if profileArn != "" {
					account.ProfileArn = profileArn
					config.UpdateAccountProfileArn(account.ID, profileArn)
				}
			}
		}

		if account.LastRefresh > 0 && now-account.LastRefresh < refreshInterval {
			continue
		}

		info, err := RefreshAccountInfo(account)
		if err != nil {
			logger.Warnf("[BackgroundRefresh] Failed to refresh %s: %v", account.Email, err)
			continue
		}

		config.UpdateAccountInfo(account.ID, *info)
		logger.Infof("[BackgroundRefresh] Refreshed %s: %s %.1f/%.1f", account.Email, info.SubscriptionType, info.UsageCurrent, info.UsageLimit)
	}
	h.pool.Reload()
}

func (h *Handler) validateApiKey(r *http.Request) bool {
	_, err := h.authenticate(r)
	return err == nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	logger.Debugf("[HTTP] %s %s from %s", r.Method, path, r.RemoteAddr)

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch")
	w.Header().Set("Access-Control-Expose-Headers", "x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens")

	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	if err := decompressRequestBody(r); err != nil {
		logger.Warnf("[HTTP] decompress failed: %v", err)
		http.Error(w, "Invalid Content-Encoding", http.StatusBadRequest)
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
		case http.MethodGet:
			h.apiGetOpenAIResponse(w, ar, id)
		case http.MethodDelete:
			h.apiDeleteOpenAIResponse(w, ar, id)
		default:
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		}
	case path == "/v1/models" || path == "/models":
		ar := h.authenticateForOpenAI(w, r)
		if ar == nil {
			return
		}
		h.handleModels(w, ar)
	case path == "/api/event_logging/batch":

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write([]byte(`{"status":"ok"}`))

	case path == "/admin" || path == "/admin/":
		h.serveAdminPage(w, r)
	case strings.HasPrefix(path, "/admin/api/"):
		h.handleAdminAPI(w, r)
	case strings.HasPrefix(path, "/admin/"):
		h.serveStaticFile(w, r)

	case path == "/health" || path == "/":
		h.handleHealth(w, r)

	case path == "/v1/stats":
		if !h.validateApiKey(r) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(401)
			json.NewEncoder(w).Encode(map[string]string{"error": "Invalid or missing API key"})
			return
		}
		h.handleStats(w, r)

	default:
		http.Error(w, "Not Found", 404)
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

func (h *Handler) handleModels(w http.ResponseWriter, _ *http.Request) {

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

	models = append(models,
		buildModelInfo("auto", "kiro-proxy", true),
		buildModelInfo("gpt-4o", "kiro-proxy", true),
		buildModelInfo("gpt-4", "kiro-proxy", true),
	)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data":   models,
	})
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
		buildModelInfo("claude-sonnet-4.6", "anthropic", true),
		buildModelInfo("claude-sonnet-4.6"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-opus-4.6", "anthropic", true),
		buildModelInfo("claude-opus-4.6"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-opus-4.7", "anthropic", true),
		buildModelInfo("claude-opus-4.7"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-sonnet-4.5", "anthropic", true),
		buildModelInfo("claude-sonnet-4.5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-sonnet-4", "anthropic", true),
		buildModelInfo("claude-sonnet-4"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-haiku-4.5", "anthropic", true),
		buildModelInfo("claude-haiku-4.5"+thinkingSuffix, "anthropic", true),
		buildModelInfo("claude-opus-4.5", "anthropic", true),
		buildModelInfo("claude-opus-4.5"+thinkingSuffix, "anthropic", true),
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
		"id":               id,
		"object":           "model",
		"owned_by":         ownedBy,
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

func (h *Handler) refreshModelsCache() {
	accounts := config.GetEnabledAccounts()
	if len(accounts) == 0 {
		return
	}

	aggregated := make([]ModelInfo, 0)
	for i := range accounts {
		account := &accounts[i]
		if err := h.ensureValidToken(account); err != nil {
			logger.Warnf("[ModelsCache] Skip %s token refresh failed: %v", account.Email, err)
			h.handleAccountFailure(account, err)
			continue
		}

		models, err := ListAvailableModels(account)
		if err != nil {
			logger.Warnf("[ModelsCache] Failed to refresh for %s: %v", account.Email, err)
			h.handleAccountFailure(account, err)
			continue
		}

		modelIDs := make([]string, 0, len(models))
		for _, m := range models {
			modelIDs = append(modelIDs, m.ModelId)
		}
		h.pool.SetModelList(account.ID, modelIDs)
		aggregated = mergeUniqueModels(aggregated, models)
	}

	if len(aggregated) > 0 {
		h.modelsCacheMu.Lock()
		h.cachedModels = aggregated
		h.modelsCacheTime = time.Now().Unix()
		h.modelsCacheMu.Unlock()
		logger.Infof("[ModelsCache] Cached %d models", len(aggregated))
	}
}

func (h *Handler) fetchAndCacheAccountModels(account *config.Account) error {
	if err := h.ensureValidToken(account); err != nil {
		return fmt.Errorf("token refresh failed: %w", err)
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
	h.modelsCacheTime = time.Now().Unix()
	h.modelsCacheMu.Unlock()

	logger.Infof("[ModelsCache] Refreshed %d models for account %s", len(models), account.Email)
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
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}

	if latest := h.pool.GetByID(id); latest != nil {
		account.AccessToken = latest.AccessToken
		account.RefreshToken = latest.RefreshToken
		account.ExpiresAt = latest.ExpiresAt
		account.ProfileArn = latest.ProfileArn
	}
	if err := h.fetchAndCacheAccountModels(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(h.pool.GetModelList(id)),
	})
}

func (h *Handler) apiRefreshAllAccountsModels(w http.ResponseWriter, _ *http.Request) {
	h.refreshModelsCache()
	h.modelsCacheMu.RLock()
	cachedLen := len(h.cachedModels)
	h.modelsCacheMu.RUnlock()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"refreshed": cachedLen,
		"failed":    0,
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
	if r.Method != "POST" {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.sendClaudeError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	var req ClaudeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.sendClaudeError(w, 400, "invalid_request_error", "Invalid JSON")
		return
	}
	if msg := validateClaudeThinkingConfig(req.Thinking, req.MaxTokens); msg != "" {
		h.sendClaudeError(w, 400, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := resolveClaudeThinkingMode(req.Model, req.Thinking, thinkingCfg.Suffix)
	req.Model = actualModel
	effectiveReq := cloneClaudeRequestForThinking(&req, thinking)

	estimatedTokens := estimateClaudeRequestInputTokens(effectiveReq)
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
	if r.Method != "POST" {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusMethodNotAllowed, "Method Not Allowed")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Failed to read request body")
		h.sendClaudeError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	var req ClaudeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		h.sendClaudeError(w, 400, "invalid_request_error", "Invalid JSON: "+err.Error())
		return
	}
	if msg := validateClaudeRequestShape(&req); msg != "" {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusBadRequest, msg)
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
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusTooManyRequests, err.Error())
		h.sendClaudeError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	kiroPayload := ClaudeToKiro(&req, thinking)

	if req.Stream {
		h.handleClaudeStream(w, r, kiroPayload, req.Model, thinking, thinkingResponseOpts, estimatedInputTokens, cacheProfile, apiKeyReservation)
	} else {
		h.handleClaudeNonStream(w, r, kiroPayload, req.Model, thinking, thinkingResponseOpts, estimatedInputTokens, cacheProfile, apiKeyReservation)
	}
}

func (h *Handler) handleClaudeStream(w http.ResponseWriter, _ *http.Request, payload *KiroPayload, model string, thinking bool, thinkingOpts claudeThinkingResponseOptions, estimatedInputTokens int, cacheProfile *promptCacheProfile, apiKeyReservation *apiKeyUsageReservation) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusInternalServerError, "Streaming not supported")
		h.sendClaudeError(w, 500, "api_error", "Streaming not supported")
		return
	}

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
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}
			cacheUsage := h.promptCache.Compute(account.ID, cacheProfile)
			messageStartUsage = cacheUsage

			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int
			var toolUses []KiroToolUse
			var nextContentIndex int
			var rawContentBuilder strings.Builder
			var rawThinkingBuilder strings.Builder
			activeBlockIndex := -1
			activeBlockType := ""

			closeActiveBlock := func() {
				if activeBlockIndex < 0 {
					return
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

			sendText := func(text string, thinkingState int) {
				if thinkingState == 0 {
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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if !messageStarted {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
					}
					break
				}
				recordFinalRequestForApiKey(apiKeyReservation, account, model, 0, 0, 0, false, 500, err.Error())
				h.sendSSE(w, flusher, "error", map[string]interface{}{
					"type":  "error",
					"error": map[string]string{"type": "api_error", "message": err.Error()},
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
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)
			h.promptCache.Update(account.ID, cacheProfile)

			stopReason := "end_turn"
			if len(toolUses) > 0 {
				stopReason = "tool_use"
			}

			ensureMessageStart()
			h.sendSSE(w, flusher, "message_delta", map[string]interface{}{
				"type": "message_delta",
				"delta": map[string]interface{}{
					"stop_reason": stopReason,
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
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, 503, "No available accounts")
		h.sendClaudeError(w, 503, "api_error", "No available accounts")
		return
	}

	recordFinalRequestForApiKey(apiKeyReservation, lastAccount, model, 0, 0, 0, false, 500, lastErr.Error())
	h.sendClaudeError(w, 500, "api_error", lastErr.Error())
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

func finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, contextInputTokens, estimatedOutputTokens int) (int, int) {
	if inputTokens <= 0 {
		if contextInputTokens > 0 {
			inputTokens = contextInputTokens
		} else {
			inputTokens = estimatedInputTokens
		}
	}
	if outputTokens <= 0 {
		outputTokens = estimatedOutputTokens
	}
	return inputTokens, outputTokens
}

func accountIdentity(account *config.Account) (string, string) {
	if account == nil {
		return "", ""
	}
	return account.ID, account.Email
}

func recordAttemptError(account *config.Account, model string, status int, err error) {
	if account == nil || err == nil {
		return
	}
	getObserveStore().RecordFailure(account.ID, model)
	getObserveStore().RecordError(account.ID, account.Email, model, status, err.Error())
}

func recordFinalRequestForApiKey(apiKeyReservation *apiKeyUsageReservation, account *config.Account, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	accountID, email := accountIdentity(account)
	getObserveStore().RecordRequestForApiKey(apiKeyReservation, accountID, email, model, inTokens, outTokens, credits, success, status, message)
}

func recordFinalRequestWithAPIKey(apiKeyID, apiKey string, account *config.Account, model string, inTokens, outTokens int, credits float64, success bool, status int, message string) {
	accountID, email := accountIdentity(account)
	getObserveStore().RecordRequestWithAPIKey(accountID, apiKeyID, apiKey, email, model, inTokens, outTokens, credits, success, status, message)
}

func (h *Handler) handleClaudeNonStream(w http.ResponseWriter, _ *http.Request, payload *KiroPayload, model string, thinking bool, thinkingOpts claudeThinkingResponseOptions, estimatedInputTokens int, cacheProfile *promptCacheProfile, apiKeyReservation *apiKeyUsageReservation) {
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}
			cacheUsage := h.promptCache.Compute(account.ID, cacheProfile)

			var content string
			var thinkingContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int

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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			thinkingFormat := thinkingOpts.Format
			finalContent, extractedReasoning := extractThinkingFromContent(content)
			rawThinkingContent := thinkingContent
			if thinking && rawThinkingContent == "" && extractedReasoning != "" {
				rawThinkingContent = extractedReasoning
			}
			if !thinking {
				rawThinkingContent = ""
			}

			estimatedOutputTokens := estimateClaudeOutputTokens(finalContent, rawThinkingContent, toolUses)
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)
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
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, 503, "No available accounts")
		h.sendClaudeError(w, 503, "api_error", "No available accounts")
		return
	}

	recordFinalRequestForApiKey(apiKeyReservation, lastAccount, model, 0, 0, 0, false, 500, lastErr.Error())
	h.sendClaudeError(w, 500, "api_error", lastErr.Error())
}

func (h *Handler) sendClaudeError(w http.ResponseWriter, status int, errType, message string) {
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
	if r.Method != "POST" {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusMethodNotAllowed, "Method Not Allowed")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Failed to read request body")
		h.sendOpenAIError(w, 400, "invalid_request_error", "Failed to read request body")
		return
	}

	var req OpenAIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, "", 0, 0, 0, false, http.StatusBadRequest, "Invalid JSON")
		h.sendOpenAIError(w, 400, "invalid_request_error", "Invalid JSON")
		return
	}
	if msg := validateOpenAIRequestShape(&req); msg != "" {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusBadRequest, msg)
		h.sendOpenAIError(w, 400, "invalid_request_error", msg)
		return
	}

	thinkingCfg := config.GetThinkingConfig()
	actualModel, thinking := ParseModelAndThinking(req.Model, thinkingCfg.Suffix)
	req.Model = actualModel
	estimatedInputTokens := estimateOpenAIRequestInputTokens(&req)
	apiKeyReservation, err := reserveApiKeyUsage(apiKeyID, apiKeyValue, tokenBudget(estimatedInputTokens))
	if err != nil {
		recordFinalRequestWithAPIKey(apiKeyID, apiKeyValue, nil, req.Model, 0, 0, 0, false, http.StatusTooManyRequests, err.Error())
		h.sendOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", err.Error())
		return
	}

	kiroPayload := OpenAIToKiro(&req, thinking)

	if req.Stream {
		h.handleOpenAIStream(w, r, kiroPayload, req.Model, thinking, estimatedInputTokens, apiKeyReservation)
	} else {
		h.handleOpenAINonStream(w, r, kiroPayload, req.Model, thinking, estimatedInputTokens, apiKeyReservation)
	}
}

func (h *Handler) handleOpenAIStream(w http.ResponseWriter, _ *http.Request, payload *KiroPayload, model string, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	defer apiKeyReservation.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, http.StatusInternalServerError, "Streaming not supported")
		h.sendOpenAIError(w, 500, "server_error", "Streaming not supported")
		return
	}

	thinkingFormat := config.GetThinkingConfig().OpenAIFormat

	chatID := "chatcmpl-" + uuid.New().String()
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			var toolCalls []ToolCall
			var toolCallIndex int
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int
			var rawContentBuilder strings.Builder
			var rawReasoningBuilder strings.Builder
			var textBuffer string
			var inThinkingBlock bool
			var dropTagThinking bool
			var thinkingSource thinkingStreamSource
			var thinkingStarted bool
			var eventThinkingOpen bool
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
						if content == "" {
							return
						}
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
					if content == "" {
						return
					}
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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if !responseStarted {
					if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
						continue
					}
					if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
						retryPlan.waitBeforeRetry(totalAttempts)
					}
					break
				}
				recordFinalRequestForApiKey(apiKeyReservation, account, model, 0, 0, 0, false, 500, err.Error())
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
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

			finishReason := "stop"
			if len(toolCalls) > 0 {
				finishReason = "tool_calls"
			}

			chunk := map[string]interface{}{
				"id":      chatID,
				"object":  "chat.completion.chunk",
				"created": time.Now().Unix(),
				"model":   model,
				"choices": []map[string]interface{}{{
					"index":         0,
					"delta":         map[string]interface{}{},
					"finish_reason": finishReason,
				}},
				"usage": map[string]int{
					"prompt_tokens":     inputTokens,
					"completion_tokens": outputTokens,
					"total_tokens":      inputTokens + outputTokens,
				},
			}
			data, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\n", string(data))
			fmt.Fprintf(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, 503, "No available accounts")
		h.sendOpenAIError(w, 503, "server_error", "No available accounts")
		return
	}

	recordFinalRequestForApiKey(apiKeyReservation, lastAccount, model, 0, 0, 0, false, 500, lastErr.Error())
	h.sendOpenAIError(w, 500, "server_error", lastErr.Error())
}

func (h *Handler) handleOpenAINonStream(w http.ResponseWriter, _ *http.Request, payload *KiroPayload, model string, thinking bool, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	defer apiKeyReservation.release()

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			if err := h.ensureValidToken(account); err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			var content string
			var reasoningContent string
			var toolUses []KiroToolUse
			var inputTokens, outputTokens int
			var credits float64
			var realInputTokens int

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
			}

			err := CallKiroAPI(account, payload, callback)
			if err != nil {
				lastErr = err
				lastAccount = account
				h.handleAccountFailure(account, err)
				recordAttemptError(account, model, 0, err)
				if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
					continue
				}
				if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
					retryPlan.waitBeforeRetry(totalAttempts)
				}
				break
			}

			finalContent, extractedReasoning := extractThinkingFromContent(content)
			if thinking && reasoningContent == "" && extractedReasoning != "" {
				reasoningContent = extractedReasoning
			} else if !thinking {
				reasoningContent = ""
			}

			estimatedOutputTokens := estimateOpenAIOutputTokens(finalContent, reasoningContent, toolUses)
			inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimatedOutputTokens)

			h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
			getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, credits)
			recordFinalRequestForApiKey(apiKeyReservation, account, model, inputTokens, outputTokens, credits, true, 200, "")
			h.pool.RecordSuccess(account.ID)
			h.pool.UpdateStats(account.ID, inputTokens+outputTokens, credits)

			thinkingFormat := config.GetThinkingConfig().OpenAIFormat
			resp := KiroToOpenAIResponseWithReasoning(finalContent, reasoningContent, toolUses, inputTokens, outputTokens, model, thinkingFormat)
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			json.NewEncoder(w).Encode(resp)
			return
		}
		excluded[account.ID] = true
	}

	if lastErr == nil {
		recordFinalRequestForApiKey(apiKeyReservation, nil, model, 0, 0, 0, false, 503, "No available accounts")
		h.sendOpenAIError(w, 503, "server_error", "No available accounts")
		return
	}

	recordFinalRequestForApiKey(apiKeyReservation, lastAccount, model, 0, 0, 0, false, 500, lastErr.Error())
	h.sendOpenAIError(w, 500, "server_error", lastErr.Error())
}

func (h *Handler) sendOpenAIError(w http.ResponseWriter, status int, errType, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]interface{}{
			"type":    errType,
			"message": message,
		},
	})
}

func (h *Handler) ensureValidToken(account *config.Account) error {
	if account.ExpiresAt == 0 || time.Now().Unix() < account.ExpiresAt-tokenRefreshSkewSeconds {
		return nil
	}

	h.tokenRefreshMu.Lock()
	defer h.tokenRefreshMu.Unlock()

	//! Another request may have refreshed the same account while this one waited.
	if latest := h.pool.GetByID(account.ID); latest != nil {
		account.AccessToken = latest.AccessToken
		account.RefreshToken = latest.RefreshToken
		account.ExpiresAt = latest.ExpiresAt
		account.ProfileArn = latest.ProfileArn
		if account.ExpiresAt == 0 || time.Now().Unix() < account.ExpiresAt-tokenRefreshSkewSeconds {
			return nil
		}
	}

	accessToken, refreshToken, expiresAt, profileArn, err := auth.RefreshToken(account)
	if err != nil {
		return err
	}

	h.pool.UpdateToken(account.ID, accessToken, refreshToken, expiresAt)
	account.AccessToken = accessToken
	if refreshToken != "" {
		account.RefreshToken = refreshToken
	}
	account.ExpiresAt = expiresAt
	if profileArn != "" {
		account.ProfileArn = profileArn
		config.UpdateAccountProfileArn(account.ID, profileArn)
	}

	config.UpdateAccountToken(account.ID, accessToken, refreshToken, expiresAt)

	return nil
}

func (h *Handler) handleAdminAPI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/admin/api/events" && r.Method == "GET" {
		h.apiEventsStream(w, r)
		return
	}

	password := r.Header.Get("X-Admin-Password")
	if password == "" {
		cookie, _ := r.Cookie("admin_password")
		if cookie != nil {
			password = cookie.Value
		}
	}

	if password != config.GetPassword() {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/admin/api")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")

	switch {
	case path == "/accounts" && r.Method == "GET":
		h.apiGetAccounts(w, r)
	case path == "/accounts" && r.Method == "POST":
		h.apiAddAccount(w, r)
	case path == "/accounts/batch" && r.Method == "POST":
		h.apiBatchAccounts(w, r)

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

	case strings.HasPrefix(path, "/accounts/") && strings.HasSuffix(path, "/full") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/accounts/"), "/full")
		h.apiGetAccountFull(w, r, id)
	case strings.HasPrefix(path, "/accounts/") && r.Method == "DELETE":
		h.apiDeleteAccount(w, r, strings.TrimPrefix(path, "/accounts/"))
	case strings.HasPrefix(path, "/accounts/") && r.Method == "PUT":
		h.apiUpdateAccount(w, r, strings.TrimPrefix(path, "/accounts/"))
	case path == "/auth/iam-sso/start" && r.Method == "POST":
		h.apiStartIamSso(w, r)
	case path == "/auth/iam-sso/complete" && r.Method == "POST":
		h.apiCompleteIamSso(w, r)
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
	case path == "/generate-machine-id" && r.Method == "GET":
		h.apiGenerateMachineId(w, r)
	case path == "/thinking" && r.Method == "GET":
		h.apiGetThinkingConfig(w, r)
	case path == "/thinking" && r.Method == "POST":
		h.apiUpdateThinkingConfig(w, r)
	case path == "/endpoint" && r.Method == "GET":
		h.apiGetEndpointConfig(w, r)
	case path == "/endpoint" && r.Method == "POST":
		h.apiUpdateEndpointConfig(w, r)
	case path == "/proxy" && r.Method == "GET":
		h.apiGetProxy(w, r)
	case path == "/proxy" && r.Method == "POST":
		h.apiUpdateProxy(w, r)
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

		stats := statsMap[a.ID]

		result[i] = map[string]interface{}{
			"id":                a.ID,
			"email":             a.Email,
			"userId":            a.UserId,
			"nickname":          a.Nickname,
			"authMethod":        a.AuthMethod,
			"provider":          a.Provider,
			"region":            a.Region,
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
			"overageStatus":     a.OverageStatus,
			"overageCapability": a.OverageCapability,
			"overageCap":        a.OverageCap,
			"overageRate":       a.OverageRate,
			"currentOverages":   a.CurrentOverages,
			"overageCheckedAt":  a.OverageCheckedAt,
			"proxyURL":          a.ProxyURL,
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

func (h *Handler) apiAddAccount(w http.ResponseWriter, r *http.Request) {
	var account config.Account
	if err := json.NewDecoder(r.Body).Decode(&account); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if account.ID == "" {
		account.ID = auth.GenerateAccountID()
	}
	if account.Region == "" {
		account.Region = "us-east-1"
	}

	if err := config.AddAccount(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()

	if account.Enabled && account.AccessToken != "" {
		go func(acc config.Account) {
			if err := h.fetchAndCacheAccountModels(&acc); err != nil {
				logger.Warnf("[ModelsCache] Auto-refresh failed for new account %s: %v", acc.Email, err)
			}
		}(account)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "id": account.ID})
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
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
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
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
	if v, ok := updates["proxyURL"].(string); ok {
		existing.ProxyURL = v
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

func (h *Handler) apiGetAccountOverage(w http.ResponseWriter, _ *http.Request, id string) {
	account := findAccountByID(id)
	if account == nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}

	snap, err := FetchOverageStatus(account)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
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
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	account := findAccountByID(id)
	if account == nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}
	if body.Enabled && strings.EqualFold(account.OverageCapability, "NOT_OVERAGE_CAPABLE") {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account is not overage capable"})
		return
	}

	snap, err := SetOverageStatus(account, body.Enabled)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}
	if len(req.IDs) == 0 {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "No account IDs provided"})
		return
	}

	switch req.Action {
	case "enable", "disable":
		enabled := req.Action == "enable"
		accounts := config.GetAccounts()
		idSet := make(map[string]bool)
		for _, id := range req.IDs {
			idSet[id] = true
		}
		var toRefreshModels []config.Account
		for _, a := range accounts {
			if idSet[a.ID] {

				if enabled && !a.Enabled && a.AccessToken != "" {
					toRefreshModels = append(toRefreshModels, a)
				}
				a.Enabled = enabled
				if enabled && a.BanStatus != "" && a.BanStatus != "ACTIVE" {
					a.BanStatus = "ACTIVE"
					a.BanReason = ""
					a.BanTime = 0
				}
				if enabled {
					a.Silent = false
					a.SilentReason = ""
					a.SilentTime = 0
				}
				config.UpdateAccount(a.ID, a)
			}
		}
		h.pool.Reload()

		for _, acc := range toRefreshModels {
			go func(a config.Account) {
				a.Enabled = true
				if err := h.fetchAndCacheAccountModels(&a); err != nil {
					logger.Warnf("[ModelsCache] Auto-refresh failed for batch-enabled account %s: %v", a.Email, err)
				}
			}(acc)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "count": len(req.IDs)})

	case "refresh":
		successCount := 0
		failCount := 0
		for _, id := range req.IDs {
			accounts := config.GetAccounts()
			var account *config.Account
			for i := range accounts {
				if accounts[i].ID == id {
					account = &accounts[i]
					break
				}
			}
			if account == nil {
				failCount++
				continue
			}

			if account.RefreshToken != "" {
				if newAccess, newRefresh, newExpires, profileArn, err := auth.RefreshToken(account); err == nil {
					account.AccessToken = newAccess
					if newRefresh != "" {
						account.RefreshToken = newRefresh
					}
					account.ExpiresAt = newExpires
					config.UpdateAccountToken(id, newAccess, newRefresh, newExpires)
					if profileArn != "" {
						account.ProfileArn = profileArn
						config.UpdateAccountProfileArn(id, profileArn)
					}
					h.pool.UpdateToken(id, newAccess, newRefresh, newExpires)
				}
			}

			info, err := RefreshAccountInfo(account)
			if err != nil {
				failCount++
				continue
			}
			config.UpdateAccountInfo(id, *info)
			successCount++
		}
		h.pool.Reload()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":   true,
			"refreshed": successCount,
			"failed":    failCount,
		})

	default:
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid action: " + req.Action})
	}
}

func (h *Handler) apiStartIamSso(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StartUrl string `json:"startUrl"`
		Region   string `json:"region"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if req.StartUrl == "" {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "startUrl is required"})
		return
	}

	sessionID, authorizeUrl, expiresIn, err := auth.StartIamSsoLogin(req.StartUrl, req.Region)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessionId":    sessionID,
		"authorizeUrl": authorizeUrl,
		"expiresIn":    expiresIn,
	})
}

func (h *Handler) apiCompleteIamSso(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID   string `json:"sessionId"`
		CallbackUrl string `json:"callbackUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	accessToken, refreshToken, clientID, clientSecret, region, expiresIn, err := auth.CompleteIamSsoLogin(req.SessionID, req.CallbackUrl)
	if err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	email, _, _ := auth.GetUserInfo(accessToken)

	account := config.Account{
		ID:           auth.GenerateAccountID(),
		Email:        email,
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

	if err := config.AddAccount(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"account": map[string]interface{}{
			"id":    account.ID,
			"email": account.Email,
		},
	})
}

func (h *Handler) apiStartBuilderIdLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Region string `json:"region"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	session, err := auth.StartBuilderIdLogin(req.Region)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessionId":       session.ID,
		"userCode":        session.UserCode,
		"verificationUri": session.VerificationUri,
		"interval":        session.Interval,
	})
}

func (h *Handler) apiPollBuilderIdAuth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	accessToken, refreshToken, clientID, clientSecret, region, expiresIn, status, err := auth.PollBuilderIdAuth(req.SessionID)
	if err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   err.Error(),
		})
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

	email, _, _ := auth.GetUserInfo(accessToken)

	account := config.Account{
		ID:           auth.GenerateAccountID(),
		Email:        email,
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

	if err := config.AddAccount(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"completed": true,
		"account": map[string]interface{}{
			"id":    account.ID,
			"email": account.Email,
		},
	})
}

func (h *Handler) apiImportSsoToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BearerToken string `json:"bearerToken"`
		Region      string `json:"region"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if req.BearerToken == "" {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "bearerToken is required"})
		return
	}

	tokens := strings.Split(strings.TrimSpace(req.BearerToken), "\n")
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

		email, _, _ := auth.GetUserInfo(accessToken)

		account := config.Account{
			ID:           auth.GenerateAccountID(),
			Email:        email,
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

		if err := config.AddAccount(account); err != nil {
			errors = append(errors, err.Error())
			continue
		}

		imported = append(imported, map[string]interface{}{
			"id":    account.ID,
			"email": account.Email,
		})
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
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
		AuthMethod   string `json:"authMethod"`
		Provider     string `json:"provider"`
		Region       string `json:"region"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if req.RefreshToken == "" {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "refreshToken is required"})
		return
	}

	if req.Region == "" {
		req.Region = "us-east-1"
	}
	if req.AuthMethod == "" {
		if req.ClientID != "" {
			req.AuthMethod = "idc"
		} else {
			req.AuthMethod = "social"
		}
	}

	switch strings.ToLower(req.AuthMethod) {
	case "idc", "builderid", "enterprise":
		req.AuthMethod = "idc"
	case "social", "google", "github":
		req.AuthMethod = "social"
	default:
		if req.ClientID != "" && req.ClientSecret != "" {
			req.AuthMethod = "idc"
		} else {
			req.AuthMethod = "social"
		}
	}

	var accessToken string
	var expiresAt int64
	tempAccount := &config.Account{
		RefreshToken: req.RefreshToken,
		ClientID:     req.ClientID,
		ClientSecret: req.ClientSecret,
		AuthMethod:   req.AuthMethod,
		Region:       req.Region,
	}
	newAccessToken, newRefreshToken, newExpiresAt, newProfileArn, err := auth.RefreshToken(tempAccount)
	if err != nil {

		if req.AccessToken != "" {
			accessToken = req.AccessToken
			expiresAt = time.Now().Unix() + 300
		} else {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "Token refresh failed: " + err.Error()})
			return
		}
	} else {
		accessToken = newAccessToken
		if newRefreshToken != "" {
			req.RefreshToken = newRefreshToken
		}
		expiresAt = newExpiresAt
	}

	email, _, _ := auth.GetUserInfo(accessToken)

	account := config.Account{
		ID:           auth.GenerateAccountID(),
		Email:        email,
		AccessToken:  accessToken,
		RefreshToken: req.RefreshToken,
		ClientID:     req.ClientID,
		ClientSecret: req.ClientSecret,
		AuthMethod:   req.AuthMethod,
		Provider:     req.Provider,
		Region:       req.Region,
		ExpiresAt:    expiresAt,
		Enabled:      true,
		MachineId:    config.GenerateMachineId(),
		ProfileArn:   newProfileArn,
	}

	if err := config.AddAccount(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.pool.Reload()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"account": map[string]interface{}{
			"id":    account.ID,
			"email": account.Email,
		},
	})
}

func (h *Handler) apiGetStatus(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(h.statusPayload(true))
}

func (h *Handler) apiGetSettings(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"requireApiKey":  config.IsApiKeyRequired(),
		"port":           config.GetPort(),
		"host":           config.GetHost(),
		"allowOverUsage": config.GetAllowOverUsage(),
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
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
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RequireApiKey  *bool  `json:"requireApiKey,omitempty"`
		Password       string `json:"password,omitempty"`
		AllowOverUsage *bool  `json:"allowOverUsage,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if err := config.UpdateSettingsPatch(req.RequireApiKey, req.Password); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	if req.AllowOverUsage != nil {
		if err := config.UpdateAllowOverUsage(*req.AllowOverUsage); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiGetStats(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(h.statusPayload(false))
}

func (h *Handler) apiResetStats(w http.ResponseWriter, _ *http.Request) {
	config.UpdateStats(0, 0, 0, 0, 0)
	getObserveStore().Reset()
	if d, err := db.Get(); err == nil {
		_, _ = d.Exec(`DELETE FROM requests`)
		_, _ = d.Exec(`DELETE FROM errors`)
	}
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
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}

	if err := h.ensureValidToken(account); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": "Token refresh failed: " + err.Error()})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Model == "" {
		req.Model = "claude-sonnet-4"
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

	var content string
	callback := &KiroStreamCallback{
		OnText:         func(text string, isThinking bool) { content += text },
		OnToolUse:      func(tu KiroToolUse) {},
		OnComplete:     func(inTok, outTok int) {},
		OnError:        func(err error) {},
		OnCredits:      func(c float64) {},
		OnContextUsage: func(pct float64) {},
	}

	err := CallKiroAPI(account, kiroPayload, callback)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"reply":   content,
		"model":   req.Model,
	})
}

func (h *Handler) apiRefreshAccount(w http.ResponseWriter, _ *http.Request, id string) {
	accounts := config.GetAccounts()
	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}

	if account == nil {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}

	refreshTokenIfNeeded := func() error {
		if account.RefreshToken == "" {
			return nil
		}
		newAccessToken, newRefreshToken, newExpiresAt, profileArn, err := auth.RefreshToken(account)
		if err != nil {
			return err
		}
		account.AccessToken = newAccessToken
		if newRefreshToken != "" {
			account.RefreshToken = newRefreshToken
		}
		account.ExpiresAt = newExpiresAt
		config.UpdateAccountToken(id, newAccessToken, newRefreshToken, newExpiresAt)
		h.pool.UpdateToken(id, newAccessToken, newRefreshToken, newExpiresAt)
		if profileArn != "" {
			account.ProfileArn = profileArn
			config.UpdateAccountProfileArn(id, profileArn)
		}
		return nil
	}

	if account.ExpiresAt > 0 && time.Now().Unix() > account.ExpiresAt-tokenRefreshSkewSeconds {
		if err := refreshTokenIfNeeded(); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": "Token refresh failed: " + err.Error()})
			return
		}
	}

	info, err := RefreshAccountInfo(account)
	if err != nil {

		errMsg := err.Error()
		errMsgLower := strings.ToLower(errMsg)
		if strings.Contains(errMsg, "TEMPORARILY_SUSPENDED") || strings.Contains(errMsgLower, "account suspended") {

			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": true,
				"message": "Account status updated",
			})
			return
		}

		if strings.Contains(errMsg, "403") || strings.Contains(errMsg, "401") || strings.Contains(errMsg, "invalid") || strings.Contains(errMsg, "expired") {
			if refreshErr := refreshTokenIfNeeded(); refreshErr == nil {

				info, err = RefreshAccountInfo(account)
				if err != nil {

					retryErrMsg := err.Error()
					if strings.Contains(retryErrMsg, "TEMPORARILY_SUSPENDED") || strings.Contains(strings.ToLower(retryErrMsg), "account suspended") {
						json.NewEncoder(w).Encode(map[string]interface{}{
							"success": true,
							"message": "Account status updated",
						})
						return
					}
				}
			}
		}

		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
	}

	if err := config.UpdateAccountInfo(id, *info); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"info":    info,
	})
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
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
		return
	}

	var stats config.Account
	for _, a := range poolAccounts {
		if a.ID == id {
			stats = a
			break
		}
	}

	result := map[string]interface{}{
		"id":                account.ID,
		"email":             account.Email,
		"userId":            account.UserId,
		"nickname":          account.Nickname,
		"accessToken":       account.AccessToken,
		"refreshToken":      account.RefreshToken,
		"clientId":          account.ClientID,
		"clientSecret":      account.ClientSecret,
		"authMethod":        account.AuthMethod,
		"provider":          account.Provider,
		"region":            account.Region,
		"expiresAt":         account.ExpiresAt,
		"machineId":         account.MachineId,
		"weight":            account.Weight,
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

func (h *Handler) apiGetAccountModels(w http.ResponseWriter, _ *http.Request, id string) {
	accounts := config.GetAccounts()
	var account *config.Account
	for i := range accounts {
		if accounts[i].ID == id {
			account = &accounts[i]
			break
		}
	}

	if account == nil {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "Account not found"})
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

func (h *Handler) serveAdminPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, "web/index.html")
}

func (h *Handler) serveStaticFile(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/admin/")
	if strings.HasPrefix(path, "vendor/") || path == "favicon.ico" {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, "web/"+path)
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	valid := map[string]bool{"auto": true, "kiro": true, "codewhisperer": true, "amazonq": true}
	if !valid[req.PreferredEndpoint] {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid endpoint, must be: auto, kiro, codewhisperer, or amazonq"})
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

	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func applyProxyConfig(proxyURL string) {
	InitKiroHttpClient(proxyURL)
	auth.InitHttpClient(proxyURL)
}

func (h *Handler) apiGetProxy(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{
		"proxyURL": config.GetProxyURL(),
	})
}

func (h *Handler) apiUpdateProxy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProxyURL string `json:"proxyURL"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}

	if req.ProxyURL != "" {
		if !strings.HasPrefix(req.ProxyURL, "http://") &&
			!strings.HasPrefix(req.ProxyURL, "https://") &&
			!strings.HasPrefix(req.ProxyURL, "socks5://") &&
			!strings.HasPrefix(req.ProxyURL, "socks5h://") {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "proxyURL must start with http://, https://, socks5://, or socks5h://"})
			return
		}
	}

	if err := config.UpdateProxySettings(req.ProxyURL); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	applyProxyConfig(req.ProxyURL)

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
		ClientID     string `json:"clientId,omitempty"`
		ClientSecret string `json:"clientSecret,omitempty"`
		Region       string `json:"region,omitempty"`
		ExpiresAt    int64  `json:"expiresAt"`
		AuthMethod   string `json:"authMethod,omitempty"`
		Provider     string `json:"provider,omitempty"`
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
		Idp          string             `json:"idp"`
		UserId       string             `json:"userId,omitempty"`
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
			ID:        a.ID,
			Email:     a.Email,
			Nickname:  a.Nickname,
			Idp:       idp,
			UserId:    a.UserId,
			MachineId: a.MachineId,
			Credentials: ExportCredentials{
				AccessToken:  a.AccessToken,
				CsrfToken:    "",
				RefreshToken: a.RefreshToken,
				ClientID:     a.ClientID,
				ClientSecret: a.ClientSecret,
				Region:       a.Region,
				ExpiresAt:    a.ExpiresAt * 1000,
				AuthMethod:   authMethod,
				Provider:     a.Provider,
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
			Tags:       []string{},
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
		Tags:       []interface{}{},
	}

	json.NewEncoder(w).Encode(data)
}

func decompressRequestBody(r *http.Request) error {
	if r.Body == nil {
		return nil
	}
	enc := strings.TrimSpace(strings.ToLower(r.Header.Get("Content-Encoding")))
	if enc == "" || enc == "identity" {
		return nil
	}
	encodings := strings.Split(enc, ",")
	for i := len(encodings) - 1; i >= 0; i-- {
		layer := strings.TrimSpace(encodings[i])
		if layer == "" || layer == "identity" {
			continue
		}
		raw, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			return err
		}
		var decoded []byte
		switch layer {
		case "gzip", "x-gzip":
			zr, gerr := gzip.NewReader(bytes.NewReader(raw))
			if gerr != nil {
				return gerr
			}
			decoded, err = io.ReadAll(zr)
			zr.Close()
		case "deflate":
			zr, zerr := zlib.NewReader(bytes.NewReader(raw))
			if zerr != nil {
				return zerr
			}
			decoded, err = io.ReadAll(zr)
			zr.Close()
		case "zstd":
			zr, zerr := zstd.NewReader(bytes.NewReader(raw))
			if zerr != nil {
				return zerr
			}
			decoded, err = io.ReadAll(zr)
			zr.Close()
		default:
			return fmt.Errorf("unsupported Content-Encoding: %s", layer)
		}
		if err != nil {
			return err
		}
		r.Body = io.NopCloser(bytes.NewReader(decoded))
		r.ContentLength = int64(len(decoded))
	}
	r.Header.Del("Content-Encoding")
	r.Header.Del("Content-Length")
	return nil
}

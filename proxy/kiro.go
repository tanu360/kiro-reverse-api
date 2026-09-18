package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

const (
	//! Upstream drops cluster in time, so an immediate retry tends to hit the same blip.
	streamRetryBackoff           = 700 * time.Millisecond
	maxStreamAttemptsPerEndpoint = 2
	maxEventStreamMessageSize    = 16 * 1024 * 1024
)

var streamRetryWait = waitForStreamRetry

type kiroEndpoint struct {
	URL       string
	Origin    string
	AmzTarget string
	Name      string
}

var kiroEndpoints = []kiroEndpoint{
	{
		URL:       "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "",
		Name:      "Kiro IDE",
	},
	{
		URL:       "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		Name:      "CodeWhisperer",
	},
	{
		URL:       "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "AmazonQDeveloperStreamingService.SendMessage",
		Name:      "AmazonQ",
	},
}

var kiroCLIEndpoint = kiroEndpoint{
	//! API key accounts use the headless Kiro CLI runtime (AWS JSON 1.0), not the IDE hosts.
	URL:       "https://runtime.us-east-1.kiro.dev/",
	Origin:    "KIRO_CLI",
	AmzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
	Name:      "Kiro CLI",
}

var kiroHttpStore atomic.Pointer[http.Client]
var kiroRestHttpStore atomic.Pointer[http.Client]

var proxyClientCache sync.Map

func init() {
	InitKiroHttpClient("")
}

func GetClientForProxy(proxyURL string) *http.Client {
	if proxyURL == "" {
		return kiroHttpStore.Load()
	}
	if cached, ok := proxyClientCache.Load(proxyURL); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		Timeout:   5 * time.Minute,
		Transport: buildKiroTransport(proxyURL),
	}
	proxyClientCache.Store(proxyURL, client)
	return client
}

func GetRestClientForProxy(proxyURL string) *http.Client {
	if proxyURL == "" {
		return kiroRestHttpStore.Load()
	}
	cacheKey := "rest:" + proxyURL
	if cached, ok := proxyClientCache.Load(cacheKey); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildKiroTransport(proxyURL),
	}
	proxyClientCache.Store(cacheKey, client)
	return client
}

func ResolveAccountProxyURL(account *config.Account) string {
	if account != nil && account.ProxyURL != "" {
		return account.ProxyURL
	}
	return config.GetProxyURL()
}

func buildKiroTransport(proxyURL string) *http.Transport {
	t := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
		ForceAttemptHTTP2:   true,
	}
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil {
			t.Proxy = http.ProxyURL(u)

			//! Proxied streaming requests are forced to HTTP/1.1 to avoid broken HTTP/2 tunnels.
			t.ForceAttemptHTTP2 = false
		}
	} else {
		t.Proxy = http.ProxyFromEnvironment
	}
	return t
}

func InitKiroHttpClient(proxyURL string) {
	client := &http.Client{
		Timeout:   5 * time.Minute,
		Transport: buildKiroTransport(proxyURL),
	}
	kiroHttpStore.Store(client)

	restClient := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildKiroTransport(proxyURL),
	}
	kiroRestHttpStore.Store(restClient)
}

type KiroPayload struct {
	ConversationState struct {
		AgentContinuationId string `json:"agentContinuationId,omitempty"`
		AgentTaskType       string `json:"agentTaskType,omitempty"`
		ChatTriggerType     string `json:"chatTriggerType"`
		ConversationID      string `json:"conversationId"`
		CurrentMessage      struct {
			UserInputMessage KiroUserInputMessage `json:"userInputMessage"`
		} `json:"currentMessage"`
		History []KiroHistoryMessage `json:"history,omitempty"`
	} `json:"conversationState"`
	ProfileArn                   string                 `json:"profileArn,omitempty"`
	InferenceConfig              *InferenceConfig       `json:"inferenceConfig,omitempty"`
	AdditionalModelRequestFields map[string]interface{} `json:"additionalModelRequestFields,omitempty"`

	//! Sanitized upstream tool names are mapped back before responses reach the client.
	ToolNameMap map[string]string `json:"-"`
}

type KiroUserInputMessage struct {
	Content                 string                   `json:"content"`
	ModelID                 string                   `json:"modelId,omitempty"`
	Origin                  string                   `json:"origin"`
	Images                  []KiroImage              `json:"images,omitempty"`
	UserInputMessageContext *UserInputMessageContext `json:"userInputMessageContext,omitempty"`
}

type UserInputMessageContext struct {
	Tools       []KiroToolWrapper `json:"tools,omitempty"`
	ToolResults []KiroToolResult  `json:"toolResults,omitempty"`
}

type KiroToolWrapper struct {
	ToolSpecification struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		InputSchema InputSchema `json:"inputSchema"`
	} `json:"toolSpecification"`
}

type InputSchema struct {
	JSON interface{} `json:"json"`
}

type KiroToolResult struct {
	ToolUseID string              `json:"toolUseId"`
	Content   []KiroResultContent `json:"content"`
	Status    string              `json:"status"`
}

type KiroResultContent struct {
	Text string `json:"text"`
}

type KiroImage struct {
	Format string `json:"format"`
	Source struct {
		Bytes string `json:"bytes"`
	} `json:"source"`
}

type KiroHistoryMessage struct {
	UserInputMessage         *KiroUserInputMessage         `json:"userInputMessage,omitempty"`
	AssistantResponseMessage *KiroAssistantResponseMessage `json:"assistantResponseMessage,omitempty"`
}

type KiroAssistantResponseMessage struct {
	Content  string        `json:"content"`
	ToolUses []KiroToolUse `json:"toolUses,omitempty"`
}

type KiroToolUse struct {
	ToolUseID string                 `json:"toolUseId"`
	Name      string                 `json:"name"`
	Input     map[string]interface{} `json:"input"`
}

type InferenceConfig struct {
	MaxTokens   int     `json:"maxTokens,omitempty"`
	Temperature float64 `json:"temperature,omitempty"`
	TopP        float64 `json:"topP,omitempty"`
}

type KiroStreamCallback struct {
	OnText         func(text string, isThinking bool)
	OnToolUse      func(toolUse KiroToolUse)
	OnComplete     func(inputTokens, outputTokens int)
	OnError        func(err error)
	OnCredits      func(credits float64)
	OnContextUsage func(percentage float64)
	OnStopReason   func(reason string)
}

func setPayloadProfileArnForAccount(payload *KiroPayload, account *config.Account) {
	if payload == nil {
		return
	}
	//! API keys carry no IDE profile; sending a stale ARN would target the wrong principal.
	if config.IsAPIKeyAccount(account) {
		payload.ProfileArn = ""
		return
	}

	payload.ProfileArn = strings.TrimSpace(payload.ProfileArn)
	if account != nil {
		if profileArn := strings.TrimSpace(account.ProfileArn); profileArn != "" {
			payload.ProfileArn = profileArn
		}
	}
}

func endpointsForAccount(account *config.Account) []kiroEndpoint {
	if config.IsAPIKeyAccount(account) {
		return []kiroEndpoint{kiroCLIEndpoint}
	}
	return getSortedEndpoints(config.GetPreferredEndpoint())
}

func kiroEndpointURL(ep kiroEndpoint, account *config.Account, profileArn string) string {
	//! Endpoints are declared for us-east-1; the profile (or an API key's region) decides the real data plane.
	if config.IsAPIKeyAccount(account) {
		return "https://runtime." + kiroRegionForProfile(account, "") + ".kiro.dev/"
	}
	return regionalizeURLForProfile(ep.URL, account, profileArn)
}

func getSortedEndpoints(preferred string) []kiroEndpoint {
	fallback := config.GetEndpointFallback()

	var primary int
	switch preferred {
	case "kiro":
		primary = 0
	case "codewhisperer":
		primary = 1
	case "amazonq":
		primary = 2
	default:

		return []kiroEndpoint{kiroEndpoints[0], kiroEndpoints[1], kiroEndpoints[2]}
	}

	if !fallback {

		return []kiroEndpoint{kiroEndpoints[primary]}
	}

	result := []kiroEndpoint{kiroEndpoints[primary]}
	for i, ep := range kiroEndpoints {
		if i != primary {
			result = append(result, ep)
		}
	}
	return result
}

func CallKiroAPI(account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	return CallKiroAPIContext(context.Background(), account, payload, callback)
}

func CallKiroAPIContext(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	//! ctx is the client request context: a disconnect aborts the upstream stream and frees the account.
	if ctx == nil {
		ctx = context.Background()
	}
	originalProfileArn := ""
	if payload != nil {
		originalProfileArn = payload.ProfileArn
		defer func() {
			payload.ProfileArn = originalProfileArn
		}()
	}
	setPayloadProfileArnForAccount(payload, account)

	if _, err := json.Marshal(payload); err != nil {
		return err
	}

	//! Full payload logging stays debug-only because it can include user prompts and tokens.
	if payloadJSON, err := json.Marshal(payload); err == nil {
		logger.Debugf("[KiroAPI] Request payload: %s", string(payloadJSON))
	}

	if callback != nil && callback.OnToolUse != nil && len(payload.ToolNameMap) > 0 {
		originalOnToolUse := callback.OnToolUse
		nameMap := payload.ToolNameMap
		wrapped := *callback
		wrapped.OnToolUse = func(tu KiroToolUse) {
			if original, ok := nameMap[tu.Name]; ok {
				tu.Name = original
			}
			originalOnToolUse(tu)
		}
		callback = &wrapped
	}

	isAPIKey := config.IsAPIKeyAccount(account)
	if payload != nil && strings.TrimSpace(payload.ProfileArn) == "" && !isAPIKey {
		if profileArn, err := resolveProfileArnContext(ctx, account); err == nil {
			payload.ProfileArn = profileArn
		} else if isProfileArnResolutionSoftError(err) {
			logger.Debugf("[ProfileArn] Skipped profile ARN resolution for %s: %v", accountEmailForLog(account), err)
		} else {
			logger.Warnf("[ProfileArn] Failed to resolve profile ARN for %s: %v", accountEmailForLog(account), err)
		}
	}

	endpoints := endpointsForAccount(account)

	var lastErr error
	var quotaErr *upstreamQuotaError
endpointLoop:
	for epIndex, ep := range endpoints {
		if err := ctx.Err(); err != nil {
			return err
		}

		payload.ConversationState.CurrentMessage.UserInputMessage.Origin = ep.Origin
		epURL := kiroEndpointURL(ep, account, payload.ProfileArn)

		reqBody, _ := json.Marshal(payload)
		host := ""
		if parsedURL, parseErr := url.Parse(epURL); parseErr == nil {
			host = parsedURL.Host
		}
		headerValues := buildStreamingHeaderValues(account, host)
		invocationID := uuid.New().String()

		for streamAttempt := 1; streamAttempt <= maxStreamAttemptsPerEndpoint; streamAttempt++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			//! A request body cannot be reused after an HTTP attempt.
			req, err := http.NewRequestWithContext(ctx, "POST", epURL, bytes.NewReader(reqBody))
			if err != nil {
				lastErr = err
				continue endpointLoop
			}

			req.Header.Set("Accept", "*/*")
			if ep.AmzTarget != "" {
				req.Header.Set("X-Amz-Target", ep.AmzTarget)
			}
			applyKiroBaseHeaders(req, account, headerValues)
			if isAPIKey {
				//! Mirrors Kiro CLI captures: AWS JSON 1.0 body, no IDE agent mode, telemetry opt-out false.
				req.Header.Set("Content-Type", "application/x-amz-json-1.0")
				req.Header.Set("x-amzn-codewhisperer-optout", "false")
			} else {
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("x-amzn-kiro-agent-mode", "vibe")
				req.Header.Set("x-amzn-codewhisperer-optout", "true")
			}
			req.Header.Set("Amz-Sdk-Request", fmt.Sprintf("attempt=%d; max=%d", streamAttempt, maxStreamAttemptsPerEndpoint))
			req.Header.Set("Amz-Sdk-Invocation-Id", invocationID)

			resp, err := GetClientForProxy(ResolveAccountProxyURL(account)).Do(req)
			if err != nil {
				lastErr = err
				if ctxErr := ctx.Err(); ctxErr != nil {
					return ctxErr
				}
				logger.Warnf("[KiroAPI] Endpoint %s failed: %v", ep.Name, err)
				if !isRetryableStreamError(err) {
					return err
				}
				continue endpointLoop
			}

			if resp.StatusCode == 429 {
				resp.Body.Close()
				logger.Warnf("[KiroAPI] Endpoint %s quota exhausted (429), trying next...", ep.Name)
				lastErr = fmt.Errorf("quota exhausted on %s", ep.Name)
				continue endpointLoop
			}

			if resp.StatusCode != 200 {
				errBody, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				lastErr = fmt.Errorf("HTTP %d from %s: %s", resp.StatusCode, ep.Name, string(errBody))
				if resp.StatusCode == http.StatusTooManyRequests {
					delay := retryAfterDuration(resp.Header.Get("Retry-After"), time.Now())
					if quotaErr == nil || delay > quotaErr.retryFor {
						quotaErr = &upstreamQuotaError{message: lastErr.Error(), retryFor: delay}
					}
					lastErr = quotaErr
				}

				if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 402 {
					return lastErr
				}
				logger.Warnf("[KiroAPI] Endpoint %s error: %v", ep.Name, lastErr)
				continue endpointLoop
			}

			emitted, err := parseEventStreamTracked(resp.Body, callback)
			resp.Body.Close()
			if err == nil {
				return nil
			}
			lastErr = err
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			//! Once a callback ran, the caller holds partial state; only the caller can decide to retry.
			if emitted || !isRetryableStreamError(err) {
				return err
			}

			hasSameEndpointRetry := streamAttempt < maxStreamAttemptsPerEndpoint
			hasEndpointFallback := epIndex+1 < len(endpoints)
			if !hasSameEndpointRetry && !hasEndpointFallback {
				break endpointLoop
			}

			logger.Warnf("[KiroAPI] Endpoint %s stream failed before any output (attempt %d/%d): %v",
				ep.Name, streamAttempt, maxStreamAttemptsPerEndpoint, err)
			if err := streamRetryWait(ctx, streamRetryBackoff); err != nil {
				return err
			}
			if !hasSameEndpointRetry {
				continue endpointLoop
			}
		}
	}

	if quotaErr != nil {
		return quotaErr
	}
	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("all endpoints failed")
}

func isRetryableStreamError(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var netErr net.Error
	return !errors.As(err, &netErr) || !netErr.Timeout()
}

func accountEmailForLog(account *config.Account) string {
	if account == nil {
		return "<nil>"
	}
	return account.Email
}

func waitForStreamRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func parseEventStream(body io.Reader, callback *KiroStreamCallback) error {
	_, err := parseEventStreamTracked(body, callback)
	return err
}

func parseEventStreamTracked(body io.Reader, callback *KiroStreamCallback) (emitted bool, err error) {
	//! emitted reports whether an output callback ran; a failure before that is safe to retry.
	if callback == nil {
		callback = &KiroStreamCallback{}
	}

	var inputTokens, outputTokens int
	var totalCredits float64
	var contextUsagePercentages []float64
	var turn streamTurnSignals
	pending := &pendingToolUses{}

	tracked := *callback
	originalOnToolUse := tracked.OnToolUse
	tracked.OnToolUse = func(toolUse KiroToolUse) {
		turn.toolCount++
		if originalOnToolUse != nil {
			emitted = true
			originalOnToolUse(toolUse)
		}
	}
	callback = &tracked

	//! Read directly from the stream so SSE chunks are not delayed by buffering.
	for {
		prelude := make([]byte, 12)
		_, readErr := io.ReadFull(body, prelude)
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return emitted, frameReadError(readErr)
		}

		totalLength := int(eventStreamUint32(prelude[0:4]))
		headersLength := int(eventStreamUint32(prelude[4:8]))
		if totalLength < 16 || totalLength > maxEventStreamMessageSize {
			return emitted, fmt.Errorf("%w: invalid frame length %d", errInvalidKiroEventStream, totalLength)
		}
		if headersLength > totalLength-16 {
			return emitted, fmt.Errorf("%w: invalid headers length %d", errInvalidKiroEventStream, headersLength)
		}
		if got, want := eventStreamUint32(prelude[8:12]), crc32.ChecksumIEEE(prelude[:8]); got != want {
			return emitted, fmt.Errorf("%w: prelude CRC mismatch", errInvalidKiroEventStream)
		}

		message := make([]byte, totalLength-len(prelude))
		if _, err := io.ReadFull(body, message); err != nil {
			return emitted, frameReadError(err)
		}
		if got, want := eventStreamUint32(message[len(message)-4:]), eventStreamChecksum(prelude, message[:len(message)-4]); got != want {
			return emitted, fmt.Errorf("%w: message CRC mismatch", errInvalidKiroEventStream)
		}

		headers, headerErr := parseEventStreamHeaders(message[:headersLength])
		if headerErr != nil {
			return emitted, fmt.Errorf("%w: %v", errInvalidKiroEventStream, headerErr)
		}
		eventType := headers[":event-type"]
		payloadBytes := message[headersLength : len(message)-4]
		event := make(map[string]interface{})
		if len(payloadBytes) > 0 {
			if err := json.Unmarshal(payloadBytes, &event); err != nil {
				//! Dropping an output frame would silently corrupt the answer; other frames are advisory.
				if isOutputEventType(eventType) {
					return emitted, fmt.Errorf("%w: decode %s payload: %v", errInvalidKiroEventStream, eventType, err)
				}
				logger.Debugf("[KiroAPI] Skipping undecodable %q frame: %v", eventType, err)
				continue
			}
		}

		if messageType := headers[":message-type"]; messageType == "error" || messageType == "exception" {
			return emitted, upstreamEventStreamError(messageType, headers, event)
		}

		inputTokens, outputTokens = updateTokensFromEvent(event, inputTokens, outputTokens)
		if reason := eventStopReason(event); reason != "" {
			turn.stopReason = reason
		}

		//! Kiro sends pure incremental deltas; de-duplicating them drops legitimately repeated text.
		switch eventType {
		case "assistantResponseEvent":
			if content, ok := event["content"].(string); ok && content != "" {
				turn.sawContent = true
				if callback.OnText != nil {
					emitted = true
					callback.OnText(content, false)
				}
			}
		case "reasoningContentEvent":
			if text, ok := event["text"].(string); ok && text != "" {
				turn.sawReasoning = true
				if callback.OnText != nil {
					emitted = true
					callback.OnText(text, true)
				}
			}
		case "toolUseEvent":
			if toolErr := handleToolUseEvent(event, pending, callback); toolErr != nil {
				return emitted, toolErr
			}
		case "meteringEvent":
			turn.sawTrailer = true
			if usage, ok := event["usage"].(float64); ok {
				totalCredits += usage
			}
		case "contextUsageEvent":
			if pct, ok := event["contextUsagePercentage"].(float64); ok {
				contextUsagePercentages = append(contextUsagePercentages, pct)
			}
		}
	}

	//! Tools that never received a stop frame are flushed in arrival order.
	if err := pending.flushAll(callback); err != nil {
		return emitted, err
	}
	logger.Debugf("[KiroAPI] Stream end: content=%t reasoning=%t tools=%d stopReason=%q trailer=%t",
		turn.sawContent, turn.sawReasoning, turn.toolCount, turn.stopReason, turn.sawTrailer)
	if err := classifyStreamIntegrity(turn); err != nil {
		return emitted, err
	}
	if callback.OnStopReason != nil {
		callback.OnStopReason(turn.stopReason)
	}
	if callback.OnCredits != nil && totalCredits > 0 {
		callback.OnCredits(totalCredits)
	}
	if callback.OnContextUsage != nil {
		for _, percentage := range contextUsagePercentages {
			callback.OnContextUsage(percentage)
		}
	}
	if callback.OnComplete != nil {
		callback.OnComplete(inputTokens, outputTokens)
	}
	return emitted, nil
}

func frameReadError(err error) error {
	//! A stream cut inside a frame is a truncation, not an account fault; other read errors pass through.
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%w: %w", errUpstreamTruncatedResponse, io.ErrUnexpectedEOF)
	}
	return err
}

func isOutputEventType(eventType string) bool {
	switch eventType {
	case "assistantResponseEvent", "reasoningContentEvent", "toolUseEvent", "metadataEvent":
		return true
	}
	return false
}

func upstreamEventStreamError(messageType string, headers map[string]string, event map[string]interface{}) error {
	detail := firstStringField(event, "message", "Message")
	kind := headers[":exception-type"]
	if kind == "" {
		kind = headers[":error-code"]
	}
	switch {
	case kind != "" && detail != "":
		detail = kind + ": " + detail
	case kind != "":
		detail = kind
	case detail == "":
		detail = messageType
	}
	return fmt.Errorf("%w: %s", errKiroEventStreamUpstream, detail)
}

func updateTokensFromEvent(event map[string]interface{}, currentInputTokens, currentOutputTokens int) (int, int) {
	candidates := []map[string]interface{}{event}
	collectUsageMaps(event, &candidates)

	inputTokens := currentInputTokens
	outputTokens := currentOutputTokens

	for _, usage := range candidates {
		if usage == nil {
			continue
		}

		if v, ok := readTokenNumber(usage,
			"outputTokens", "completionTokens", "totalOutputTokens",
			"output_tokens", "completion_tokens", "total_output_tokens",
		); ok {
			outputTokens = v
		}

		if v, ok := readTokenNumber(usage,
			"inputTokens", "promptTokens", "totalInputTokens",
			"input_tokens", "prompt_tokens", "total_input_tokens",
		); ok {
			inputTokens = v
			continue
		}

		uncached, _ := readTokenNumber(usage, "uncachedInputTokens", "uncached_input_tokens")
		cacheRead, _ := readTokenNumber(usage, "cacheReadInputTokens", "cache_read_input_tokens")
		cacheWrite, _ := readTokenNumber(usage, "cacheWriteInputTokens", "cache_write_input_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens")
		if uncached+cacheRead+cacheWrite > 0 {
			inputTokens = uncached + cacheRead + cacheWrite
			continue
		}

		total, ok := readTokenNumber(usage, "totalTokens", "total_tokens")
		if ok && total > 0 {
			candidateOutput := outputTokens
			if v, vok := readTokenNumber(usage,
				"outputTokens", "completionTokens", "totalOutputTokens",
				"output_tokens", "completion_tokens", "total_output_tokens",
			); vok {
				candidateOutput = v
			}
			if total-candidateOutput > 0 {
				inputTokens = total - candidateOutput
			}
		}
	}

	return inputTokens, outputTokens
}

func getContextWindowSize(model string) int {
	if isLargeContextModel(model) {
		return 1_000_000
	}
	return 200_000
}

var claudeVersionExtractor = regexp.MustCompile(`claude-(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:\D|$)`)

func isLargeContextModel(model string) bool {
	m := strings.ToLower(model)

	//! Minor is optional (claude-opus-5) and capped at two digits so date snapshots
	//! like claude-sonnet-4-20250514 read as 4.0, not minor 20250514.
	if match := claudeVersionExtractor.FindStringSubmatch(m); match != nil {
		major, errMaj := strconv.Atoi(match[1])
		if errMaj == nil {
			if major > 4 {
				return true
			}
			minor := 0
			if match[2] != "" {
				parsed, errMin := strconv.Atoi(match[2])
				if errMin != nil {
					return false
				}
				minor = parsed
			}
			return major == 4 && minor >= 6
		}
	}
	for _, tag := range []string{"4.6", "4-6", "4.7", "4-7", "4.8", "4-8", "4.9", "4-9"} {
		if strings.Contains(m, tag) {
			return true
		}
	}
	return false
}

func collectUsageMaps(v interface{}, out *[]map[string]interface{}) {
	switch t := v.(type) {
	case map[string]interface{}:
		for k, child := range t {
			lk := strings.ToLower(k)
			if lk == "usage" || lk == "tokenusage" || lk == "token_usage" {
				if m, ok := child.(map[string]interface{}); ok {
					*out = append(*out, m)
				}
			}
			collectUsageMaps(child, out)
		}
	case []interface{}:
		for _, child := range t {
			collectUsageMaps(child, out)
		}
	}
}

func readTokenNumber(m map[string]interface{}, keys ...string) (int, bool) {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch n := v.(type) {
		case float64:
			return int(n), true
		case int:
			return n, true
		case int64:
			return int(n), true
		case json.Number:
			if parsed, err := n.Int64(); err == nil {
				return int(parsed), true
			}
		case string:
			if parsed, err := strconv.Atoi(n); err == nil {
				return parsed, true
			}
			if parsed, err := strconv.ParseFloat(n, 64); err == nil {
				return int(parsed), true
			}
		}
	}
	return 0, false
}

type toolUseState struct {
	ToolUseID   string
	Name        string
	InputBuffer strings.Builder
	GeneratedID bool
}

type pendingToolUses struct {
	//! Keyed by toolUseId so interleaved parallel frames accumulate independently.
	//! order keeps arrival sequence: Go map iteration is random, tool call order is not.
	byID   map[string]*toolUseState
	order  []string
	lastID string
}

func (p *pendingToolUses) get(id string) *toolUseState {
	if p.byID == nil {
		return nil
	}
	return p.byID[id]
}

func (p *pendingToolUses) add(state *toolUseState) {
	if p.byID == nil {
		p.byID = make(map[string]*toolUseState)
	}
	p.byID[state.ToolUseID] = state
	p.order = append(p.order, state.ToolUseID)
	p.lastID = state.ToolUseID
}

func (p *pendingToolUses) rekey(state *toolUseState, newID string) {
	//! rekey swaps a generated id for the real upstream id and keeps the arrival position.
	oldID := state.ToolUseID
	delete(p.byID, oldID)
	for i, id := range p.order {
		if id == oldID {
			p.order[i] = newID
			break
		}
	}
	state.ToolUseID = newID
	state.GeneratedID = false
	p.byID[newID] = state
	if p.lastID == oldID {
		p.lastID = newID
	}
}

func (p *pendingToolUses) remove(id string) {
	delete(p.byID, id)
	for i, existing := range p.order {
		if existing == id {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
	if p.lastID == id {
		p.lastID = ""
	}
}

func (p *pendingToolUses) flushAll(callback *KiroStreamCallback) error {
	//! flushAll stops at the first incomplete tool so the caller retries instead of running it without arguments.
	order := p.order
	byID := p.byID
	p.byID = nil
	p.order = nil
	p.lastID = ""
	for _, id := range order {
		if err := finishToolUse(byID[id], callback); err != nil {
			return err
		}
	}
	return nil
}

func handleToolUseEvent(event map[string]interface{}, pending *pendingToolUses, callback *KiroStreamCallback) error {
	//! A fragment without toolUseId continues the most recently seen tool.
	toolUseID := firstStringField(event, "toolUseId", "toolUseID", "tool_use_id", "id")
	name := firstStringField(event, "name", "toolName", "tool_name")
	isStop := firstBoolField(event, "stop", "isStop", "done")

	var state *toolUseState

	switch {
	case toolUseID != "":
		state = pending.get(toolUseID)
		if state == nil && pending.lastID != "" {
			//! The opening fragment may lack an id; adopt that synthetic entry so its JSON is not split in two.
			if prev := pending.get(pending.lastID); prev != nil && prev.GeneratedID && (name == "" || prev.Name == name) {
				pending.rekey(prev, toolUseID)
				state = prev
			}
		}
		if state == nil {
			if name == "" {
				return nil
			}
			state = &toolUseState{ToolUseID: toolUseID, Name: name}
			pending.add(state)
		} else {
			if name != "" && state.Name == "" {
				state.Name = name
			}
			pending.lastID = state.ToolUseID
		}
	case pending.lastID != "" && pending.get(pending.lastID) != nil:
		state = pending.get(pending.lastID)
		if name != "" && state.Name != name {
			//! A new name without an id closes the tool in flight instead of mixing arguments.
			if err := finishToolUse(state, callback); err != nil {
				return err
			}
			pending.remove(state.ToolUseID)
			state = &toolUseState{ToolUseID: "toolu_" + uuid.New().String(), Name: name, GeneratedID: true}
			pending.add(state)
		}
	case name != "":
		state = &toolUseState{ToolUseID: "toolu_" + uuid.New().String(), Name: name, GeneratedID: true}
		pending.add(state)
	default:
		return nil
	}

	if input, ok := event["input"].(string); ok {
		state.InputBuffer.WriteString(input)
	} else if inputObj, ok := event["input"].(map[string]interface{}); ok {
		data, _ := json.Marshal(inputObj)
		state.InputBuffer.Reset()
		state.InputBuffer.Write(data)
	}

	if isStop {
		if err := finishToolUse(state, callback); err != nil {
			return err
		}
		pending.remove(state.ToolUseID)
	}
	return nil
}

func finishToolUse(state *toolUseState, callback *KiroStreamCallback) error {
	//! Invalid argument JSON is an error: a write or shell tool must never run with {} input.
	if state == nil || state.Name == "" {
		return nil
	}
	if state.ToolUseID == "" {
		state.ToolUseID = "toolu_" + uuid.New().String()
	}
	var input map[string]interface{}
	if raw := strings.TrimSpace(state.InputBuffer.String()); raw != "" {
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			return fmt.Errorf("%w: %s: %v", errIncompleteKiroToolInput, state.Name, err)
		}
	}
	if input == nil {
		input = make(map[string]interface{})
	}
	if callback == nil || callback.OnToolUse == nil {
		return nil
	}
	callback.OnToolUse(KiroToolUse{
		ToolUseID: state.ToolUseID,
		Name:      state.Name,
		Input:     input,
	})
	return nil
}

func firstStringField(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func firstBoolField(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		if v, ok := m[key].(bool); ok {
			return v
		}
	}
	return false
}

func eventStreamUint32(data []byte) uint32 {
	return uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3])
}

func eventStreamChecksum(prelude, message []byte) uint32 {
	//! The message CRC covers the prelude (including its CRC) and every byte up to the trailing checksum.
	checksum := crc32.Update(0, crc32.IEEETable, prelude)
	return crc32.Update(checksum, crc32.IEEETable, message)
}

func parseEventStreamHeaders(data []byte) (map[string]string, error) {
	//! Only string headers are kept; other value types are skipped by their fixed or prefixed length.
	headers := make(map[string]string)
	for offset := 0; offset < len(data); {
		nameLength := int(data[offset])
		offset++
		if nameLength == 0 || offset+nameLength >= len(data) {
			return nil, errors.New("malformed event header name")
		}
		name := string(data[offset : offset+nameLength])
		offset += nameLength
		valueType := data[offset]
		offset++

		valueLength := 0
		switch valueType {
		case 0, 1:
			continue
		case 2:
			valueLength = 1
		case 3:
			valueLength = 2
		case 4:
			valueLength = 4
		case 5, 8:
			valueLength = 8
		case 9:
			valueLength = 16
		case 6, 7:
			if offset+2 > len(data) {
				return nil, errors.New("malformed variable event header")
			}
			valueLength = int(data[offset])<<8 | int(data[offset+1])
			offset += 2
		default:
			return nil, fmt.Errorf("unsupported event header type %d", valueType)
		}
		if offset+valueLength > len(data) {
			return nil, errors.New("truncated event header value")
		}
		if valueType == 7 {
			headers[name] = string(data[offset : offset+valueLength])
		}
		offset += valueLength
	}
	return headers, nil
}

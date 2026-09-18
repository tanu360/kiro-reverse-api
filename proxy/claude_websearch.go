package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"

	"github.com/google/uuid"
)

const (
	//! Claude Code's WebSearch tool sends this prefix in a sub-request whose only tool is native web_search.
	claudeCodeWebSearchPrefix = "Perform a web search for the query:"
	maxClaudeWebSearchUses    = 5
	webSearchTextChunkRunes   = 100
)

var (
	errNoWebSearchAccounts = errors.New("no available accounts for web_search")
	errNoClaudeAccounts    = errors.New("no available accounts")
)

type claudeWebSearchMode int

const (
	claudeWebSearchNone claudeWebSearchMode = iota
	claudeWebSearchDirect
	claudeWebSearchLoop
)

type claudeWebSearchRound struct {
	text         string
	thinking     string
	toolUses     []KiroToolUse
	inputTokens  int
	outputTokens int
	credits      float64
	stopReason   string
}

type webSearchOutcome struct {
	query   string
	results []WebSearchResult
	//! errorCode uses Anthropic's web_search_tool_result_error codes, e.g. "unavailable".
	errorCode string
	errorText string
}

func isNativeWebSearchTool(tool ClaudeTool) bool {
	//! Only the typed server tool counts; a client tool that is merely named web_search stays a client tool.
	return strings.TrimSpace(tool.Name) == webSearchToolName &&
		strings.HasPrefix(strings.ToLower(strings.TrimSpace(tool.Type)), "web_search_")
}

func hasNativeWebSearchTool(tools []ClaudeTool) bool {
	for _, tool := range tools {
		if isNativeWebSearchTool(tool) {
			return true
		}
	}
	return false
}

func clientToolShadowsWebSearch(tools []ClaudeTool) bool {
	//! A client tool with the same Kiro name wins; the model then calls that tool and the client runs it.
	kiroName := shortenToolName(sanitizeToolName(webSearchToolName))
	for _, tool := range tools {
		if !isNativeWebSearchTool(tool) && shortenToolName(sanitizeToolName(tool.Name)) == kiroName {
			return true
		}
	}
	return false
}

func withKiroWebSearchTool(tools []ClaudeTool) []ClaudeTool {
	if !hasNativeWebSearchTool(tools) {
		return tools
	}
	out := make([]ClaudeTool, 0, len(tools))
	for _, tool := range tools {
		if !isNativeWebSearchTool(tool) {
			out = append(out, tool)
		}
	}
	if clientToolShadowsWebSearch(tools) {
		return out
	}
	return append(out, ClaudeTool{
		Name:        webSearchToolName,
		Description: "Search the web for current information.",
		InputSchema: webSearchInputSchema(),
	})
}

func claudeWebSearchModeFor(req *ClaudeRequest) (claudeWebSearchMode, string) {
	if req == nil || !hasNativeWebSearchTool(req.Tools) || clientToolShadowsWebSearch(req.Tools) {
		return claudeWebSearchNone, ""
	}
	choice, name := claudeToolChoice(req.ToolChoice)
	if choice == "none" || (choice == "tool" && name != webSearchToolName) {
		return claudeWebSearchNone, ""
	}
	//! Only Claude Code's search sub-request skips the model; a chat that merely allows search still gets an answer.
	if len(req.Tools) == 1 {
		if query := claudeCodeSearchQuery(req.Messages); query != "" {
			return claudeWebSearchDirect, query
		}
	}
	return claudeWebSearchLoop, ""
}

func claudeCodeSearchQuery(messages []ClaudeMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if strings.TrimSpace(messages[i].Role) != "user" {
			continue
		}
		for _, text := range claudeTextBlocks(messages[i].Content) {
			trimmed := strings.TrimSpace(text)
			if strings.HasPrefix(trimmed, claudeCodeWebSearchPrefix) {
				return strings.TrimSpace(strings.TrimPrefix(trimmed, claudeCodeWebSearchPrefix))
			}
		}
		return ""
	}
	return ""
}

func claudeTextBlocks(content interface{}) []string {
	switch c := content.(type) {
	case string:
		return []string{c}
	case []interface{}:
		texts := make([]string, 0, len(c))
		for _, raw := range c {
			block, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			if blockType, _ := block["type"].(string); blockType != "text" {
				continue
			}
			if text, ok := block["text"].(string); ok {
				texts = append(texts, text)
			}
		}
		return texts
	}
	return nil
}

func resolveClaudeWebSearchMaxUses(tools []ClaudeTool) int {
	//! Client max_uses may lower the budget, never raise it past the proxy cap.
	maxUses := 0
	for _, tool := range tools {
		if isNativeWebSearchTool(tool) && tool.MaxUses > maxUses {
			maxUses = tool.MaxUses
		}
	}
	if maxUses <= 0 || maxUses > maxClaudeWebSearchUses {
		return maxClaudeWebSearchUses
	}
	return maxUses
}

func newServerToolUseID() string {
	return "srvtoolu_" + strings.ReplaceAll(uuid.NewString(), "-", "")
}

func webSearchPageAge(published string) interface{} {
	published = strings.TrimSpace(published)
	if published == "" {
		return nil
	}
	//! MCP sends epoch milliseconds; Anthropic shows page_age as a readable date.
	if ms, err := strconv.ParseInt(published, 10, 64); err == nil && ms > 0 {
		return time.UnixMilli(ms).UTC().Format("January 2, 2006")
	}
	return published
}

func webSearchResultBlocks(results []WebSearchResult) []map[string]interface{} {
	blocks := make([]map[string]interface{}, 0, len(results))
	for _, result := range results {
		blocks = append(blocks, map[string]interface{}{
			"type":              "web_search_result",
			"title":             result.Title,
			"url":               result.URL,
			"encrypted_content": result.Snippet,
			"page_age":          webSearchPageAge(result.PublishedDate),
		})
	}
	return blocks
}

func webSearchPresentationBlocks(outcome webSearchOutcome) []map[string]interface{} {
	id := newServerToolUseID()
	var resultContent interface{} = webSearchResultBlocks(outcome.results)
	if outcome.errorCode != "" {
		resultContent = map[string]interface{}{
			"type":       "web_search_tool_result_error",
			"error_code": outcome.errorCode,
		}
	}
	return []map[string]interface{}{
		{
			"type":  "server_tool_use",
			"id":    id,
			"name":  webSearchToolName,
			"input": map[string]interface{}{"query": outcome.query},
		},
		{
			"type":        "web_search_tool_result",
			"tool_use_id": id,
			"content":     resultContent,
		},
	}
}

func generateWebSearchSummary(query string, results []WebSearchResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Here are the search results for %q:\n\n", query)
	if len(results) == 0 {
		b.WriteString("No results found.\n")
	}
	for i, result := range results {
		fmt.Fprintf(&b, "%d. **%s**\n", i+1, strings.TrimSpace(result.Title))
		if snippet := []rune(strings.TrimSpace(result.Snippet)); len(snippet) > 0 {
			if len(snippet) > 200 {
				snippet = append(snippet[:200], []rune("...")...)
			}
			fmt.Fprintf(&b, "   %s\n", string(snippet))
		}
		fmt.Fprintf(&b, "   Source: %s\n\n", result.URL)
	}
	b.WriteString("\nPlease note that these are web search results and may not be fully accurate or up-to-date.")
	return b.String()
}

func webSearchOutcomeToolResultText(outcome webSearchOutcome) string {
	if outcome.errorCode != "" {
		return "web_search failed (" + outcome.errorCode + "): " + outcome.errorText
	}
	return generateWebSearchSummary(outcome.query, outcome.results)
}

func webSearchResultHistoryText(content interface{}) string {
	items, ok := content.([]interface{})
	if !ok || len(items) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\nWeb search results:")
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		title := strings.TrimSpace(scalarString(item["title"]))
		url := strings.TrimSpace(scalarString(item["url"]))
		if title == "" && url == "" {
			continue
		}
		fmt.Fprintf(&b, "\n- %s (%s)", title, url)
	}
	return b.String()
}

func splitWebSearchToolUses(toolUses []KiroToolUse) (search, client []KiroToolUse) {
	for _, tu := range toolUses {
		//! Exact name only: Claude Code's own client tool "WebSearch" must reach the client.
		if tu.Name == webSearchToolName {
			search = append(search, tu)
		} else {
			client = append(client, tu)
		}
	}
	return search, client
}

func (h *Handler) searchWebWithFailover(ctx context.Context, model, query string) ([]WebSearchResult, *config.Account, error) {
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account
	for attempt := 0; attempt < newRequestRetryPlan().maxPerRequest; attempt++ {
		account := h.pool.GetNextForModelExcluding(model, excluded)
		if account == nil {
			break
		}
		excluded[account.ID] = true
		lastAccount = account
		if err := h.ensureValidTokenContext(ctx, account); err != nil {
			if ctx.Err() != nil {
				return nil, account, ctx.Err()
			}
			lastErr = err
			h.handleAccountFailure(account, err)
			recordAttemptError(account, model, 0, err)
			continue
		}
		results, err := performKiroWebSearch(ctx, account, query)
		if err == nil {
			return results, account, nil
		}
		if ctx.Err() != nil {
			return nil, account, ctx.Err()
		}
		//! MCP errors never touch account health: its 403 would otherwise ban an account that chats fine.
		lastErr = err
		recordAttemptError(account, model, 0, err)
	}
	if lastErr == nil {
		lastErr = errNoWebSearchAccounts
	}
	return nil, lastAccount, lastErr
}

func (h *Handler) runWebSearches(ctx context.Context, model string, toolUses []KiroToolUse, used *int, maxUses int) []webSearchOutcome {
	outcomes := make([]webSearchOutcome, 0, len(toolUses))
	for _, tu := range toolUses {
		outcome := webSearchOutcome{query: webSearchQueryFromInput(tu.Input)}
		switch {
		case outcome.query == "":
			outcome.errorCode, outcome.errorText = "invalid_input", "query is required"
		case *used >= maxUses:
			outcome.errorCode, outcome.errorText = "max_uses_exceeded", fmt.Sprintf("the web_search limit of %d uses is reached; answer with the results you have", maxUses)
		default:
			*used++
			results, _, err := h.searchWebWithFailover(ctx, model, outcome.query)
			if err != nil {
				outcome.errorCode, outcome.errorText = "unavailable", err.Error()
			}
			outcome.results = results
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes
}

func (h *Handler) handleClaudeDirectWebSearch(w http.ResponseWriter, r *http.Request, model, query string, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation, stream bool) {
	defer apiKeyReservation.release()

	results, account, err := h.searchWebWithFailover(r.Context(), model, query)
	if err != nil {
		if isContextCanceledError(err) {
			recordClientDisconnect(r.Context(), apiKeyReservation, account, model)
			return
		}
		status := http.StatusBadGateway
		if errors.Is(err, errNoWebSearchAccounts) {
			status = http.StatusServiceUnavailable
		}
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, account, model, 0, 0, 0, false, status, err.Error())
		h.sendClaudeError(w, status, "api_error", "Web search failed: "+err.Error())
		return
	}

	content := []map[string]interface{}{{"type": "text", "text": fmt.Sprintf("I'll search for %q.", query)}}
	content = append(content, webSearchPresentationBlocks(webSearchOutcome{query: query, results: results})...)
	content = append(content, map[string]interface{}{"type": "text", "text": generateWebSearchSummary(query, results)})

	inputTokens := estimatedInputTokens
	outputTokens := estimateWebSearchContentTokens(content)
	h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, 0)
	getObserveStore().RecordSuccess(account.ID, model, inputTokens, outputTokens, 0)
	recordFinalRequestForApiKey(r.Context(), apiKeyReservation, account, model, inputTokens, outputTokens, 0, true, 200, "")

	h.writeClaudeWebSearchResponse(w, stream, model, content, "end_turn", inputTokens, outputTokens, 1)
}

func (h *Handler) runClaudeWebSearchLoop(w http.ResponseWriter, r *http.Request, req *ClaudeRequest, thinking bool, thinkingOpts claudeThinkingResponseOptions, estimatedInputTokens int, apiKeyReservation *apiKeyUsageReservation) {
	defer apiKeyReservation.release()
	ctx := r.Context()

	working := *req
	working.Messages = append([]ClaudeMessage(nil), req.Messages...)
	maxUses := resolveClaudeWebSearchMaxUses(req.Tools)
	presented := make([]map[string]interface{}, 0)
	searches := 0
	outputTokens := 0
	inputTokens := 0
	var credits float64
	var lastAccount *config.Account

	//! Every search round spends budget, so at most maxUses+2 upstream calls run before the final answer.
	for roundIdx := 0; ; roundIdx++ {
		if roundIdx > 0 {
			estimatedInputTokens = estimateClaudeRequestInputTokens(cloneClaudeRequestForThinking(&working, thinking))
		}
		round, account, err := h.callClaudeRoundWithFailover(ctx, &working, thinking, estimatedInputTokens)
		if account != nil {
			lastAccount = account
		}
		if err != nil {
			if isContextCanceledError(err) {
				recordClientDisconnect(r.Context(), apiKeyReservation, lastAccount, req.Model)
				return
			}
			status, message := http.StatusInternalServerError, err.Error()
			if errors.Is(err, errNoClaudeAccounts) {
				//! Same text as the plain Claude path, so clients see one message for an empty pool.
				status, message = http.StatusServiceUnavailable, "No available accounts"
			}
			recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, req.Model, 0, 0, 0, false, status, message)
			h.sendClaudeError(w, status, "api_error", message)
			return
		}
		credits += round.credits
		outputTokens += round.outputTokens
		inputTokens += round.inputTokens
		getObserveStore().RecordSuccess(account.ID, req.Model, round.inputTokens, round.outputTokens, round.credits)
		h.pool.RecordSuccess(account.ID)
		h.pool.UpdateStats(account.ID, round.inputTokens+round.outputTokens, round.credits)

		searchUses, clientUses := splitWebSearchToolUses(round.toolUses)
		if len(searchUses) > 0 && len(clientUses) == 0 && roundIdx <= maxUses {
			outcomes := h.runWebSearches(ctx, req.Model, searchUses, &searches, maxUses)
			if ctx.Err() != nil {
				recordClientDisconnect(r.Context(), apiKeyReservation, lastAccount, req.Model)
				return
			}
			appendWebSearchRound(&working, round, searchUses, outcomes)
			// The requested server tool has run; follow-up rounds may answer normally.
			working.ToolChoice = map[string]interface{}{"type": "auto"}
			for _, outcome := range outcomes {
				presented = append(presented, webSearchPresentationBlocks(outcome)...)
			}
			continue
		}

		//! Final round: searches next to client tools still run, but only the client sees their results.
		content := append([]map[string]interface{}(nil), presented...)
		finalText := round.text
		if thinking && round.thinking != "" {
			switch {
			case thinkingOpts.OmitDisplay:
				content = append(content, map[string]interface{}{"type": "thinking", "thinking": ""})
			case thinkingOpts.Format == "think":
				finalText = "<think>" + round.thinking + "</think>" + finalText
			case thinkingOpts.Format == "reasoning_content":
				finalText = round.thinking + finalText
			default:
				content = append(content, map[string]interface{}{"type": "thinking", "thinking": round.thinking})
			}
		}
		if strings.TrimSpace(finalText) != "" {
			content = append(content, map[string]interface{}{"type": "text", "text": finalText})
		}
		for _, tu := range round.toolUses {
			if tu.Name == webSearchToolName {
				outcomes := h.runWebSearches(ctx, req.Model, []KiroToolUse{tu}, &searches, maxUses)
				content = append(content, webSearchPresentationBlocks(outcomes[0])...)
				continue
			}
			input := tu.Input
			if input == nil {
				input = map[string]interface{}{}
			}
			content = append(content, map[string]interface{}{
				"type":  "tool_use",
				"id":    tu.ToolUseID,
				"name":  tu.Name,
				"input": input,
			})
		}
		if ctx.Err() != nil {
			recordClientDisconnect(r.Context(), apiKeyReservation, lastAccount, req.Model)
			return
		}

		stopReason := mapClaudeStopReason(round.stopReason, len(clientUses))
		h.recordSuccessForApiKey(apiKeyReservation, inputTokens, outputTokens, credits)
		recordFinalRequestForApiKey(r.Context(), apiKeyReservation, lastAccount, req.Model, inputTokens, outputTokens, credits, true, 200, "")

		h.writeClaudeWebSearchResponse(w, req.Stream, req.Model, content, stopReason, inputTokens, outputTokens, searches)
		return
	}
}

func (h *Handler) callClaudeRoundWithFailover(ctx context.Context, req *ClaudeRequest, thinking bool, estimatedInputTokens int) (*claudeWebSearchRound, *config.Account, error) {
	payload := ClaudeToKiro(req, thinking)
	excluded := make(map[string]bool)
	var lastErr error
	var lastAccount *config.Account

	retryPlan := newRequestRetryPlan()
	totalAttempts := 0
	for totalAttempts < retryPlan.maxPerRequest {
		account := h.pickAccount(payload, req.Model, excluded)
		if account == nil {
			break
		}
		for accountAttempt := 0; accountAttempt < retryPlan.maxPerAccount && totalAttempts < retryPlan.maxPerRequest; accountAttempt++ {
			totalAttempts++
			round, err := h.callClaudeRound(ctx, account, payload, req.Model, thinking, estimatedInputTokens)
			if err == nil {
				h.rememberAccount(payload, account)
				return round, account, nil
			}
			lastErr = err
			lastAccount = account
			if isContextCanceledError(err) {
				return nil, account, err
			}
			h.handleAccountFailure(account, err)
			recordAttemptError(account, req.Model, 0, err)
			if retryPlan.canRetrySameAccount(err, accountAttempt, totalAttempts) {
				retryPlan.waitBeforeRetry(ctx, totalAttempts)
				continue
			}
			if retryPlan.shouldBackoffBeforeNextAccount(err, totalAttempts) {
				retryPlan.waitBeforeRetry(ctx, totalAttempts)
			}
			break
		}
		excluded[account.ID] = true
	}
	if lastErr == nil {
		lastErr = errNoClaudeAccounts
	}
	return nil, lastAccount, lastErr
}

func (h *Handler) callClaudeRound(ctx context.Context, account *config.Account, payload *KiroPayload, model string, thinking bool, estimatedInputTokens int) (*claudeWebSearchRound, error) {
	if err := h.ensureValidTokenContext(ctx, account); err != nil {
		return nil, err
	}
	var text, reasoning string
	var toolUses []KiroToolUse
	var inputTokens, outputTokens, realInputTokens int
	var credits float64
	var stopReason string
	callback := &KiroStreamCallback{
		OnText: func(t string, isThinking bool) {
			if isThinking {
				reasoning += t
			} else {
				text += t
			}
		},
		OnToolUse:  func(tu KiroToolUse) { toolUses = append(toolUses, tu) },
		OnComplete: func(inTok, outTok int) { inputTokens, outputTokens = inTok, outTok },
		OnCredits:  func(c float64) { credits = c },
		OnContextUsage: func(pct float64) {
			realInputTokens = int(pct * float64(getContextWindowSize(model)) / 100.0)
		},
		OnStopReason: func(reason string) { stopReason = reason },
	}
	if err := CallKiroAPIContext(ctx, account, payload, callback); err != nil {
		return nil, err
	}
	text, extracted := extractThinkingFromContent(text)
	if reasoning == "" {
		reasoning = extracted
	}
	if !thinking {
		reasoning = ""
	}
	inputTokens, outputTokens = finalizeUsageTokens(inputTokens, outputTokens, estimatedInputTokens, realInputTokens, estimateClaudeOutputTokens(text, reasoning, toolUses))
	return &claudeWebSearchRound{
		text:         text,
		thinking:     reasoning,
		toolUses:     toolUses,
		inputTokens:  inputTokens,
		outputTokens: outputTokens,
		credits:      credits,
		stopReason:   stopReason,
	}, nil
}

func appendWebSearchRound(req *ClaudeRequest, round *claudeWebSearchRound, toolUses []KiroToolUse, outcomes []webSearchOutcome) {
	//! []interface{} is the shape JSON decoding gives, so ClaudeToKiro reads these blocks like client history.
	assistant := make([]interface{}, 0, len(toolUses)+1)
	if strings.TrimSpace(round.text) != "" {
		assistant = append(assistant, map[string]interface{}{"type": "text", "text": round.text})
	}
	results := make([]interface{}, 0, len(toolUses))
	for i, tu := range toolUses {
		input := tu.Input
		if input == nil {
			input = map[string]interface{}{}
		}
		assistant = append(assistant, map[string]interface{}{
			"type":  "tool_use",
			"id":    tu.ToolUseID,
			"name":  tu.Name,
			"input": input,
		})
		results = append(results, map[string]interface{}{
			"type":        "tool_result",
			"tool_use_id": tu.ToolUseID,
			"content":     webSearchOutcomeToolResultText(outcomes[i]),
		})
	}
	req.Messages = append(req.Messages,
		ClaudeMessage{Role: "assistant", Content: assistant},
		ClaudeMessage{Role: "user", Content: results},
	)
}

func estimateWebSearchContentTokens(content []map[string]interface{}) int {
	total := 0
	for _, block := range content {
		switch block["type"] {
		case "text":
			text, _ := block["text"].(string)
			total += estimateApproxTokens(text)
		case "tool_use", "server_tool_use":
			name, _ := block["name"].(string)
			total += estimateApproxTokens(name) + estimateJSONTokens(block["input"])
		case "web_search_tool_result":
			total += estimateJSONTokens(block["content"])
		}
	}
	if total < 1 {
		return 1
	}
	return total
}

func webSearchUsage(inputTokens, outputTokens, searches int) map[string]interface{} {
	return map[string]interface{}{
		"input_tokens":                inputTokens,
		"output_tokens":               outputTokens,
		"cache_creation_input_tokens": 0,
		"cache_read_input_tokens":     0,
		"server_tool_use":             map[string]interface{}{"web_search_requests": searches},
	}
}

func (h *Handler) writeClaudeWebSearchResponse(w http.ResponseWriter, stream bool, model string, content []map[string]interface{}, stopReason string, inputTokens, outputTokens, searches int) {
	msgID := "msg_" + uuid.New().String()
	if !stream {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":            msgID,
			"type":          "message",
			"role":          "assistant",
			"model":         model,
			"content":       content,
			"stop_reason":   stopReason,
			"stop_sequence": nil,
			"usage":         webSearchUsage(inputTokens, outputTokens, searches),
		})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.sendClaudeError(w, http.StatusInternalServerError, "api_error", "Streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	h.sendSSE(w, flusher, "message_start", map[string]interface{}{
		"type": "message_start",
		"message": map[string]interface{}{
			"id":            msgID,
			"type":          "message",
			"role":          "assistant",
			"model":         model,
			"content":       []interface{}{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage":         webSearchUsage(inputTokens, 0, 0),
		},
	})
	for index, block := range content {
		h.sendWebSearchContentBlock(w, flusher, index, block)
	}
	h.sendSSE(w, flusher, "message_delta", map[string]interface{}{
		"type":  "message_delta",
		"delta": map[string]interface{}{"stop_reason": stopReason, "stop_sequence": nil},
		"usage": map[string]interface{}{
			"output_tokens":   outputTokens,
			"server_tool_use": map[string]interface{}{"web_search_requests": searches},
		},
	})
	h.sendSSE(w, flusher, "message_stop", map[string]interface{}{"type": "message_stop"})
}

func (h *Handler) sendWebSearchContentBlock(w http.ResponseWriter, flusher http.Flusher, index int, block map[string]interface{}) {
	blockType, _ := block["type"].(string)
	start := block
	var deltas []map[string]interface{}
	switch blockType {
	case "thinking":
		start = map[string]interface{}{"type": "thinking", "thinking": ""}
		text, _ := block["thinking"].(string)
		for _, chunk := range chunkByRunes(text, webSearchTextChunkRunes) {
			deltas = append(deltas, map[string]interface{}{"type": "thinking_delta", "thinking": chunk})
		}
	case "text":
		start = map[string]interface{}{"type": "text", "text": ""}
		text, _ := block["text"].(string)
		for _, chunk := range chunkByRunes(text, webSearchTextChunkRunes) {
			deltas = append(deltas, map[string]interface{}{"type": "text_delta", "text": chunk})
		}
	case "tool_use", "server_tool_use":
		//! Like the real API: empty input on start, then the whole input as one input_json_delta.
		start = make(map[string]interface{}, len(block))
		for k, v := range block {
			start[k] = v
		}
		start["input"] = map[string]interface{}{}
		partial, _ := json.Marshal(block["input"])
		deltas = append(deltas, map[string]interface{}{"type": "input_json_delta", "partial_json": string(partial)})
	}
	h.sendSSE(w, flusher, "content_block_start", map[string]interface{}{
		"type":          "content_block_start",
		"index":         index,
		"content_block": start,
	})
	for _, delta := range deltas {
		h.sendSSE(w, flusher, "content_block_delta", map[string]interface{}{
			"type":  "content_block_delta",
			"index": index,
			"delta": delta,
		})
	}
	h.sendSSE(w, flusher, "content_block_stop", map[string]interface{}{
		"type":  "content_block_stop",
		"index": index,
	})
}

func chunkByRunes(s string, size int) []string {
	runes := []rune(s)
	if len(runes) == 0 {
		return nil
	}
	if size <= 0 {
		return []string{s}
	}
	chunks := make([]string, 0, (len(runes)+size-1)/size)
	for i := 0; i < len(runes); i += size {
		end := i + size
		if end > len(runes) {
			end = len(runes)
		}
		chunks = append(chunks, string(runes[i:end]))
	}
	return chunks
}

package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/proxypool"

	"github.com/google/uuid"
)

const (
	webSearchToolName     = "web_search"
	kiroWebSearchToolName = "webSearch"
	// defaultWebSearchResults is how many results a search keeps unless the request asks for
	// more or fewer. Kiro's search returns up to 10.
	defaultWebSearchResults = 5
)

type WebSearchResult struct {
	Title         string `json:"title"`
	URL           string `json:"url"`
	Snippet       string `json:"snippet"`
	PublishedDate string `json:"publishedDate,omitempty"`
}

func (r *WebSearchResult) UnmarshalJSON(data []byte) error {
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	r.Title = scalarString(raw["title"])
	r.URL = scalarString(firstExisting(raw, "url", "link"))
	r.Snippet = scalarString(firstExisting(raw, "snippet", "description", "text"))
	r.PublishedDate = scalarString(firstExisting(raw, "publishedDate", "published_date", "date"))
	return nil
}

func isHostedWebSearchToolType(toolType string) bool {
	t := strings.ToLower(strings.TrimSpace(toolType))
	return t == "web_search" || t == "web_search_preview" || strings.HasPrefix(t, "web_search_preview_")
}

func webSearchInputSchema() interface{} {
	return map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"query": map[string]interface{}{
				"type":        "string",
				"description": "Search query",
			},
		},
		"required": []string{"query"},
	}
}

func isWebSearchToolUse(tu KiroToolUse) bool {
	name := strings.ToLower(strings.TrimSpace(tu.Name))
	name = strings.ReplaceAll(name, "_", "")
	name = strings.ReplaceAll(name, "-", "")
	return name == "websearch"
}

// hostedWebSearch is one web search the proxy runs for the model on the OpenAI APIs. The
// handler gets the same value when the search starts and again, done, when it ends.
type hostedWebSearch struct {
	// id names the search to the client: the web_search_call item id on /v1/responses.
	id      string
	query   string
	results []WebSearchResult
	err     error
	done    bool
}

func newWebSearchCallID() string {
	return "ws_" + strings.ReplaceAll(uuid.NewString(), "-", "")
}

// hostedSearchRound is what one model round that ended in hosted searches spent. The reply's
// last round reports through OnComplete and OnContextUsage as any reply does; these rounds come
// on top, so a reply that searched counts the prompt of every round it sent.
type hostedSearchRound struct {
	// inputTokens and outputTokens are Kiro's own counts for the round, usually 0.
	inputTokens, outputTokens int
	// contextUsage is the round's contextUsagePercentage, 0 when Kiro sent none.
	contextUsage float64
	// shownTokens estimates the text and reasoning the round streamed, which the reply's own
	// output estimate already holds.
	shownTokens int
	// callTokens estimates the round's search calls.
	callTokens int
	// addedTokens estimates what the follow-up adds to the prompt: the round's text, its
	// calls and their results.
	addedTokens int
}

// hostedSearchHooks connect the hosted search loop to the handler. A nil value, or any nil
// field, is fine.
type hostedSearchHooks struct {
	// model is the client's model, for the error log of a failed search.
	model string
	// onSearch receives each search when it starts and again when it ends.
	onSearch func(search *hostedWebSearch)
	// onRound receives the usage of each round that ended in searches, before the next round.
	onRound func(round hostedSearchRound)
}

func (h *hostedSearchHooks) report(search *hostedWebSearch) {
	if h != nil && h.onSearch != nil {
		h.onSearch(search)
	}
}

func (h *hostedSearchHooks) countRound(round hostedSearchRound) {
	if h != nil && h.onRound != nil {
		h.onRound(round)
	}
}

// search runs one query on the reply's account and records it as a web_search attempt of the
// request, as the Anthropic path does. A failed query is not retried: the model is told.
// limit is how many results to keep, 0 for defaultWebSearchResults.
func (h *hostedSearchHooks) search(ctx context.Context, account *config.Account, query string, limit int) ([]WebSearchResult, error) {
	traceAttemptStart(ctx, account, attemptEndpointWebSearch)
	results, err := performKiroWebSearch(ctx, account, query, limit)
	if err == nil {
		traceAttemptOK(ctx)
		return results, nil
	}
	if ctx.Err() != nil {
		return nil, err
	}
	logger.Warnf("[WebSearch] %s: search failed: %s", accountEmailForLog(account), proxypool.LogText(err))
	traceAttemptFailed(ctx, account, 0, err)
	traceAttemptGiveUp(ctx)
	if h != nil && h.model != "" {
		//! As recordAttemptError logs it, but the RPM start stays: the reply's chat already reached Kiro.
		recordAttemptErrorMetric(account, 0, err)
		getObserveStore().RecordFailure(account.ID, h.model)
		getObserveStore().RecordError(account.ID, account.Email, h.model, 0, err.Error())
	}
	return nil, err
}

// resolveWebSearchToolResults runs the searches a round asked for. limit is how many results
// each keeps, 0 for defaultWebSearchResults.
func resolveWebSearchToolResults(ctx context.Context, account *config.Account, toolUses []KiroToolUse, hooks *hostedSearchHooks, limit int) ([]KiroToolResult, error) {
	results := make([]KiroToolResult, 0, len(toolUses))
	for _, tu := range toolUses {
		if !isWebSearchToolUse(tu) {
			return nil, fmt.Errorf("unsupported hosted tool: %s", tu.Name)
		}
		search := &hostedWebSearch{id: newWebSearchCallID(), query: webSearchQueryFromInput(tu.Input)}
		hooks.report(search)
		search.results, search.err = hooks.search(ctx, account, search.query, limit)
		search.done = true
		hooks.report(search)
		text := formatWebSearchResults(search.results)
		status := "success"
		if err := search.err; err != nil {
			status = "error"
			text = "web_search failed: " + err.Error()
		}
		results = append(results, KiroToolResult{
			ToolUseID: tu.ToolUseID,
			Content:   []KiroResultContent{{Text: text}},
			Status:    status,
		})
	}
	return results, nil
}

// buildWebSearchFollowupPayload replays the turn with the searches the reply asked for and their
// results. text is what the reply said before it searched, kept in the history as the client saw it.
func buildWebSearchFollowupPayload(base *KiroPayload, toolUses []KiroToolUse, results []KiroToolResult, text string) *KiroPayload {
	if base == nil {
		return nil
	}
	next := *base
	current := base.ConversationState.CurrentMessage.UserInputMessage
	historyUser := current
	if current.UserInputMessageContext != nil {
		contextCopy := *current.UserInputMessageContext
		historyUser.UserInputMessageContext = &contextCopy
	}
	history := make([]KiroHistoryMessage, len(base.ConversationState.History))
	for i, message := range base.ConversationState.History {
		history[i] = message
		if message.AssistantResponseMessage != nil {
			copied := *message.AssistantResponseMessage
			history[i].AssistantResponseMessage = &copied
		}
		if message.UserInputMessage != nil {
			copied := *message.UserInputMessage
			if copied.UserInputMessageContext != nil {
				ctxCopy := *copied.UserInputMessageContext
				copied.UserInputMessageContext = &ctxCopy
			}
			history[i].UserInputMessage = &copied
		}
	}
	historyTools := append([]KiroToolUse(nil), toolUses...)
	for i := range historyTools {
		for upstream, original := range base.ToolNameMap {
			if historyTools[i].Name == original {
				historyTools[i].Name = upstream
				break
			}
		}
	}
	history = append(history,
		KiroHistoryMessage{UserInputMessage: &historyUser},
		KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: strings.TrimSpace(text), ToolUses: historyTools}},
	)
	ids := make(map[string]bool, len(results))
	for _, result := range results {
		ids[result.ToolUseID] = true
	}
	var declared map[string]string
	if current.UserInputMessageContext != nil {
		declared = structuredToolHistoryNames(current.UserInputMessageContext.Tools, base.ToolNameMap)
	}
	next.ConversationState.History = sanitizeKiroHistoryForTools(history, ids, declared)
	next.ConversationState.CurrentMessage.UserInputMessage = KiroUserInputMessage{
		Content: buildToolResultsContinuation(results),
		ModelID: current.ModelID,
		Origin:  current.Origin,
		UserInputMessageContext: &UserInputMessageContext{
			ToolResults: results,
		},
	}
	if current.UserInputMessageContext != nil && len(current.UserInputMessageContext.Tools) > 0 {
		next.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools = current.UserInputMessageContext.Tools
	}
	return &next
}

// performKiroWebSearch runs one query on Kiro's web search and keeps the first limit results,
// defaultWebSearchResults for 0.
func performKiroWebSearch(ctx context.Context, account *config.Account, query string, limit int) ([]WebSearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if !config.IsAPIKeyAccount(account) {
		if _, err := resolveProfileArnContext(reqCtx, account); err != nil {
			return nil, err
		}
	}

	body, _ := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      uuid.NewString(),
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name": webSearchToolName,
			"arguments": map[string]interface{}{
				"query": query,
			},
		},
	})

	endpoint := webSearchMCPHost(account) + "/mcp"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	setKiroHeaders(req, account)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Amz-Sdk-Request", "attempt=1; max=3")
	req.Header.Set("Amz-Sdk-Invocation-Id", uuid.NewString())
	if !config.IsAPIKeyAccount(account) && account != nil {
		//! Kiro IDE names the profile on MCP calls; API keys carry no profile.
		if arn, _, ok := parseKiroProfileArn(requestProfileArn(account)); ok {
			req.Header.Set("x-amzn-kiro-profile-arn", arn)
		}
	}

	resp, err := accountClient(account, false).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MCP HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	results, err := parseMCPWebSearchResponse(data)
	return capWebSearchResults(results, limit), err
}

func webSearchMCPHost(account *config.Account) string {
	//! account.Region is the login region; MCP lives next to the profile, like every other data-plane call.
	return "https://" + kiroDataPlaneHost(kiroRegionForProfile(account, ""))
}

func webSearchQueryFromInput(input map[string]interface{}) string {
	for _, key := range []string{"query", "q", "search_query", "searchQuery"} {
		if value := strings.TrimSpace(scalarString(input[key])); value != "" {
			return value
		}
	}
	return ""
}

func parseMCPWebSearchResponse(data []byte) ([]WebSearchResult, error) {
	var rpc struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &rpc); err != nil {
		return nil, err
	}
	if rpc.Error != nil {
		return nil, errors.New(rpc.Error.Message)
	}
	if rpc.Result.IsError {
		if len(rpc.Result.Content) > 0 {
			return nil, errors.New(rpc.Result.Content[0].Text)
		}
		return nil, errors.New("web_search tool error")
	}
	for _, content := range rpc.Result.Content {
		if strings.ToLower(content.Type) != "text" || strings.TrimSpace(content.Text) == "" {
			continue
		}
		if results, ok, err := decodeWebSearchResults([]byte(content.Text)); ok {
			return results, err
		}
	}
	if results, ok, err := decodeWebSearchResults(data); ok {
		return results, err
	}
	//! A 200 with no readable results must fail, or callers show an empty search as a real answer.
	return nil, errors.New("web_search returned no readable results")
}

func decodeWebSearchResults(data []byte) ([]WebSearchResult, bool, error) {
	//! ok means the payload is a search result; an empty list is a valid answer, an error field is not.
	var wrapped struct {
		Results *[]WebSearchResult `json:"results"`
		Error   string             `json:"error"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil {
		if msg := strings.TrimSpace(wrapped.Error); msg != "" {
			return nil, true, errors.New(msg)
		}
		if wrapped.Results != nil {
			return *wrapped.Results, true, nil
		}
	}
	var bare []WebSearchResult
	if err := json.Unmarshal(data, &bare); err == nil && bare != nil {
		return bare, true, nil
	}
	return nil, false, nil
}

// capWebSearchResults keeps the first limit results, defaultWebSearchResults for 0.
func capWebSearchResults(results []WebSearchResult, limit int) []WebSearchResult {
	if limit <= 0 {
		limit = defaultWebSearchResults
	}
	if len(results) > limit {
		return results[:limit]
	}
	return results
}

func formatWebSearchResults(results []WebSearchResult) string {
	if len(results) == 0 {
		return "No web search results found."
	}
	var b strings.Builder
	for i, result := range results {
		if i > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString(". ")
		b.WriteString(strings.TrimSpace(result.Title))
		if result.URL != "" {
			b.WriteString("\nURL: ")
			b.WriteString(result.URL)
		}
		if published := webSearchPublishedText(result.PublishedDate); published != "" {
			b.WriteString("\nPublished: ")
			b.WriteString(published)
		}
		if result.Snippet != "" {
			b.WriteString("\n")
			b.WriteString(result.Snippet)
		}
	}
	return b.String()
}

func scalarString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprint(t)
	}
}

// Hosted tools never reach the client as executable function calls. Text still
// streams normally; tool calls are held until the upstream turn is complete.
//
// The rounds before the last report their usage through hostedSearchHooks.onRound; the
// last round reports through OnComplete and OnContextUsage, as a reply without searches
// does. Credits and cache counts are summed over every round.
func callKiroWithHostedSearch(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	if len(payload.HostedSearchTools) == 0 {
		return CallKiroAPIContext(ctx, account, payload, callback)
	}
	const maxRounds = 5
	hooks := callback.hostedSearch
	next := payload
	totalCredits := 0.0
	var totalCache cacheTokenCounts
	// spoke is whether the answer so far ends in text that a later round's text would run into.
	spoke := false
	for round := 0; round <= maxRounds; round++ {
		if round > 0 {
			//! Each round is an attempt of its own in the request log, after the searches before it.
			traceAttemptStart(ctx, account, "")
		}
		var tools []KiroToolUse
		var said, reasoning strings.Builder
		stop := ""
		roundIn, roundOut := 0, 0
		var contextUsage []float64
		cb := *callback
		cb.OnText = func(text string, isThinking bool) {
			if isThinking {
				reasoning.WriteString(text)
			} else if text != "" {
				//! Each round is a new assistant message: the text after a search started
				//! on the same line as the text before it ("…the latest posts:Based on…").
				if said.Len() == 0 && spoke && !strings.HasPrefix(text, "\n") && callback.OnText != nil {
					callback.OnText("\n\n", false)
				}
				said.WriteString(text)
				spoke = !strings.HasSuffix(text, "\n")
			}
			if callback.OnText != nil {
				callback.OnText(text, isThinking)
			}
		}
		cb.OnToolUse = func(tu KiroToolUse) { tools = append(tools, tu) }
		cb.OnComplete = func(in, out int) { roundIn, roundOut = in, out }
		cb.OnContextUsage = func(pct float64) { contextUsage = append(contextUsage, pct) }
		cb.OnCredits = func(c float64) { totalCredits += c }
		cb.OnStopReason = func(reason string) { stop = reason }
		cb.OnCacheUsage = func(read, write int) { totalCache.Read += read; totalCache.Write += write }
		if err := CallKiroAPIContext(ctx, account, next, &cb); err != nil {
			return err
		}
		var searches, clientTools []KiroToolUse
		for _, tu := range tools {
			if payload.HostedSearchTools[tu.Name] {
				searches = append(searches, tu)
			} else {
				clientTools = append(clientTools, tu)
			}
		}
		// finish ends the reply with this round, the one the client's own tools or answer came from.
		finish := func() {
			for _, tu := range clientTools {
				if callback.OnToolUse != nil {
					callback.OnToolUse(tu)
				}
			}
			if callback.OnContextUsage != nil {
				for _, pct := range contextUsage {
					callback.OnContextUsage(pct)
				}
			}
			if callback.OnCacheUsage != nil && totalCache.Read+totalCache.Write > 0 {
				callback.OnCacheUsage(totalCache.Read, totalCache.Write)
			}
			if callback.OnComplete != nil {
				callback.OnComplete(roundIn, roundOut)
			}
			if callback.OnCredits != nil {
				callback.OnCredits(totalCredits)
			}
			if callback.OnStopReason != nil {
				callback.OnStopReason(stop)
			}
		}
		if len(searches) == 0 {
			finish()
			return nil
		}
		if round == maxRounds {
			return fmt.Errorf("hosted web search exceeded %d rounds", maxRounds)
		}
		canonicalSearches := append([]KiroToolUse(nil), searches...)
		for i := range canonicalSearches {
			canonicalSearches[i].Name = webSearchToolName
		}
		results, err := resolveWebSearchToolResults(ctx, account, canonicalSearches, hooks, payload.HostedSearchResults)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(clientTools) > 0 {
			// Client tools must return before another upstream turn can complete them.
			// Include completed hosted results in text and expose only client-owned calls.
			if callback.OnText != nil {
				callback.OnText(buildToolResultsContinuation(results), false)
			}
			finish()
			return nil
		}
		//! generateAssistantResponse streams thinking inline as <thinking> text; the follow-up
		//! replays only the answer, since Claude 5 refuses reasoning as history text.
		answer, inlineThinking := splitInlineThinking(said.String())
		next = buildWebSearchFollowupPayload(next, searches, results, answer)
		hooks.countRound(searchRoundUsage(roundIn, roundOut, contextUsage, answer, reasoning.String()+inlineThinking, searches, next))
		if callback.onFollowupPayload != nil {
			callback.onFollowupPayload(next)
		}
	}
	return nil
}

// searchRoundUsage estimates what a round that ended in searches spent and what its follow-up
// adds to the prompt.
func searchRoundUsage(inputTokens, outputTokens int, contextUsage []float64, said, reasoning string, searches []KiroToolUse, followup *KiroPayload) hostedSearchRound {
	round := hostedSearchRound{
		inputTokens:  inputTokens,
		outputTokens: outputTokens,
		shownTokens:  estimateApproxTokens(said) + estimateApproxTokens(reasoning),
	}
	if n := len(contextUsage); n > 0 {
		round.contextUsage = contextUsage[n-1]
	}
	for _, tu := range searches {
		round.callTokens += estimateApproxTokens(tu.Name) + estimateJSONTokens(tu.Input)
	}
	round.addedTokens = estimateApproxTokens(said) + round.callTokens
	current := followup.ConversationState.CurrentMessage.UserInputMessage
	round.addedTokens += estimateApproxTokens(current.Content)
	if current.UserInputMessageContext != nil {
		for _, result := range current.UserInputMessageContext.ToolResults {
			for _, content := range result.Content {
				round.addedTokens += estimateApproxTokens(content.Text)
			}
		}
	}
	return round
}

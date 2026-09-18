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

	"github.com/google/uuid"
)

const (
	webSearchToolName     = "web_search"
	kiroWebSearchToolName = "webSearch"
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

func allWebSearchToolUses(toolUses []KiroToolUse) bool {
	if len(toolUses) == 0 {
		return false
	}
	for _, tu := range toolUses {
		if !isWebSearchToolUse(tu) {
			return false
		}
	}
	return true
}

func resolveWebSearchToolResults(ctx context.Context, account *config.Account, toolUses []KiroToolUse) ([]KiroToolResult, error) {
	results := make([]KiroToolResult, 0, len(toolUses))
	for _, tu := range toolUses {
		if !isWebSearchToolUse(tu) {
			return nil, fmt.Errorf("unsupported hosted tool: %s", tu.Name)
		}
		searchResults, err := performKiroWebSearch(ctx, account, webSearchQueryFromInput(tu.Input))
		text := formatWebSearchResults(searchResults)
		status := "success"
		if err != nil {
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

func buildWebSearchFollowupPayload(base *KiroPayload, toolUses []KiroToolUse, results []KiroToolResult) *KiroPayload {
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
		KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: historyTools}},
	)
	ids := make(map[string]bool, len(results))
	for _, result := range results {
		ids[result.ToolUseID] = true
	}
	next.ConversationState.History = sanitizeKiroHistory(history, ids)
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

func performKiroWebSearch(ctx context.Context, account *config.Account, query string) ([]WebSearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if !config.IsAPIKeyAccount(account) {
		if _, err := resolveProfileArnContext(reqCtx, account); err != nil && !isProfileArnResolutionSoftError(err) {
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
		if arn, _, ok := parseKiroProfileArn(account.ProfileArn); ok {
			req.Header.Set("x-amzn-kiro-profile-arn", arn)
		}
	}

	resp, err := GetRestClientForProxy(ResolveAccountProxyURL(account)).Do(req)
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
	return parseMCPWebSearchResponse(data)
}

func webSearchMCPHost(account *config.Account) string {
	//! account.Region is the login region; MCP lives next to the profile, like every other data-plane call.
	return "https://q." + kiroRegionForProfile(account, "") + ".amazonaws.com"
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
			return capWebSearchResults(results), err
		}
	}
	if results, ok, err := decodeWebSearchResults(data); ok {
		return capWebSearchResults(results), err
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

func capWebSearchResults(results []WebSearchResult) []WebSearchResult {
	if len(results) > 5 {
		return results[:5]
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
		if result.PublishedDate != "" {
			b.WriteString("\nPublished: ")
			b.WriteString(result.PublishedDate)
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
func callKiroWithHostedSearch(ctx context.Context, account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	if len(payload.HostedSearchTools) == 0 {
		return CallKiroAPIContext(ctx, account, payload, callback)
	}
	const maxRounds = 5
	next := payload
	totalIn, totalOut := 0, 0
	totalCredits := 0.0
	for round := 0; round <= maxRounds; round++ {
		var tools []KiroToolUse
		stop := ""
		cb := *callback
		cb.OnToolUse = func(tu KiroToolUse) { tools = append(tools, tu) }
		cb.OnComplete = func(in, out int) { totalIn += in; totalOut += out }
		cb.OnCredits = func(c float64) { totalCredits += c }
		cb.OnStopReason = func(reason string) { stop = reason }
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
		if len(searches) == 0 {
			for _, tu := range clientTools {
				if callback.OnToolUse != nil {
					callback.OnToolUse(tu)
				}
			}
			if callback.OnComplete != nil {
				callback.OnComplete(totalIn, totalOut)
			}
			if callback.OnCredits != nil {
				callback.OnCredits(totalCredits)
			}
			if callback.OnStopReason != nil {
				callback.OnStopReason(stop)
			}
			return nil
		}
		if round == maxRounds {
			return fmt.Errorf("hosted web search exceeded %d rounds", maxRounds)
		}
		canonicalSearches := append([]KiroToolUse(nil), searches...)
		for i := range canonicalSearches {
			canonicalSearches[i].Name = webSearchToolName
		}
		results, err := resolveWebSearchToolResults(ctx, account, canonicalSearches)
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
			for _, tu := range clientTools {
				if callback.OnToolUse != nil {
					callback.OnToolUse(tu)
				}
			}
			if callback.OnComplete != nil {
				callback.OnComplete(totalIn, totalOut)
			}
			if callback.OnCredits != nil {
				callback.OnCredits(totalCredits)
			}
			if callback.OnStopReason != nil {
				callback.OnStopReason(stop)
			}
			return nil
		}
		next = buildWebSearchFollowupPayload(next, searches, results)
	}
	return nil
}

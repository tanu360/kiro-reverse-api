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

func resolveWebSearchToolResults(account *config.Account, toolUses []KiroToolUse) ([]KiroToolResult, error) {
	results := make([]KiroToolResult, 0, len(toolUses))
	for _, tu := range toolUses {
		if !isWebSearchToolUse(tu) {
			return nil, fmt.Errorf("unsupported hosted tool: %s", tu.Name)
		}
		searchResults, err := performKiroWebSearch(context.Background(), account, tu)
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
	historyUser.UserInputMessageContext = nil
	history := append([]KiroHistoryMessage(nil), base.ConversationState.History...)
	history = append(history,
		KiroHistoryMessage{UserInputMessage: &historyUser},
		KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{ToolUses: toolUses}},
	)
	next.ConversationState.History = history
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

func performKiroWebSearch(ctx context.Context, account *config.Account, toolUse KiroToolUse) ([]WebSearchResult, error) {
	query := webSearchQueryFromInput(toolUse.Input)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

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
	region := "us-east-1"
	if account != nil && strings.TrimSpace(account.Region) != "" {
		region = strings.TrimSpace(account.Region)
	}
	return "https://q." + region + ".amazonaws.com"
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
		if results, ok := decodeWebSearchResults([]byte(content.Text)); ok {
			return capWebSearchResults(results), nil
		}
	}
	if results, ok := decodeWebSearchResults(data); ok {
		return capWebSearchResults(results), nil
	}
	return nil, nil
}

func decodeWebSearchResults(data []byte) ([]WebSearchResult, bool) {
	var wrapped struct {
		Results []WebSearchResult `json:"results"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil && len(wrapped.Results) > 0 {
		return wrapped.Results, true
	}
	var bare []WebSearchResult
	if err := json.Unmarshal(data, &bare); err == nil && len(bare) > 0 {
		return bare, true
	}
	return nil, false
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

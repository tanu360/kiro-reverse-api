package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func nativeWebSearchTool() ClaudeTool {
	return ClaudeTool{Type: "web_search_20250305", Name: webSearchToolName}
}

func bashClaudeTool() ClaudeTool {
	return ClaudeTool{Name: "Bash", Description: "run", InputSchema: map[string]interface{}{"type": "object"}}
}

func TestNativeWebSearchToolNeedsServerToolType(t *testing.T) {
	if !isNativeWebSearchTool(nativeWebSearchTool()) {
		t.Fatal("typed web_search tool must be native")
	}
	if isNativeWebSearchTool(ClaudeTool{Name: webSearchToolName, Description: "client search"}) {
		t.Fatal("client tool merely named web_search must not be native")
	}
	if hasNativeWebSearchTool(nil) {
		t.Fatal("no tools must not report native web_search")
	}
}

func TestClaudeToolServerFieldsDecode(t *testing.T) {
	var tool ClaudeTool
	if err := json.Unmarshal([]byte(`{"type":"web_search_20250305","name":"web_search","max_uses":3}`), &tool); err != nil {
		t.Fatal(err)
	}
	if tool.Type != "web_search_20250305" || tool.MaxUses != 3 || !isNativeWebSearchTool(tool) {
		t.Fatalf("decoded tool = %+v", tool)
	}
}

func TestClaudeWebSearchModeFor(t *testing.T) {
	arrayReq := ClaudeRequest{}
	if err := json.Unmarshal([]byte(`{"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: golang generics"}]}]}`), &arrayReq); err != nil {
		t.Fatal(err)
	}
	arrayReq.Tools = []ClaudeTool{nativeWebSearchTool()}

	tests := []struct {
		name      string
		req       *ClaudeRequest
		wantMode  claudeWebSearchMode
		wantQuery string
	}{
		{name: "no tools", req: &ClaudeRequest{Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}}, wantMode: claudeWebSearchNone},
		{
			name:     "client tool named web_search",
			req:      &ClaudeRequest{Tools: []ClaudeTool{{Name: webSearchToolName}}, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}},
			wantMode: claudeWebSearchNone,
		},
		{
			name:     "client tool shadows native",
			req:      &ClaudeRequest{Tools: []ClaudeTool{nativeWebSearchTool(), {Name: "WebSearch"}}, Messages: []ClaudeMessage{{Role: "user", Content: "hi"}}},
			wantMode: claudeWebSearchNone,
		},
		{
			name:      "Claude Code sub-request",
			req:       &ClaudeRequest{Tools: []ClaudeTool{nativeWebSearchTool()}, Messages: []ClaudeMessage{{Role: "user", Content: "Perform a web search for the query: rust 2026"}}},
			wantMode:  claudeWebSearchDirect,
			wantQuery: "rust 2026",
		},
		{name: "array content", req: &arrayReq, wantMode: claudeWebSearchDirect, wantQuery: "golang generics"},
		{
			name: "last user turn wins",
			req: &ClaudeRequest{Tools: []ClaudeTool{nativeWebSearchTool()}, Messages: []ClaudeMessage{
				{Role: "user", Content: "Perform a web search for the query: first"},
				{Role: "assistant", Content: "ok"},
				{Role: "user", Content: "Perform a web search for the query: second"},
			}},
			wantMode:  claudeWebSearchDirect,
			wantQuery: "second",
		},
		{
			name:     "plain chat that allows search",
			req:      &ClaudeRequest{Tools: []ClaudeTool{nativeWebSearchTool()}, Messages: []ClaudeMessage{{Role: "user", Content: "what is new in Go?"}}},
			wantMode: claudeWebSearchLoop,
		},
		{
			name:     "prefix next to client tools",
			req:      &ClaudeRequest{Tools: []ClaudeTool{nativeWebSearchTool(), bashClaudeTool()}, Messages: []ClaudeMessage{{Role: "user", Content: "Perform a web search for the query: x"}}},
			wantMode: claudeWebSearchLoop,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mode, query := claudeWebSearchModeFor(tt.req)
			if mode != tt.wantMode || query != tt.wantQuery {
				t.Fatalf("mode=%d query=%q, want mode=%d query=%q", mode, query, tt.wantMode, tt.wantQuery)
			}
		})
	}
}

func TestResolveClaudeWebSearchMaxUses(t *testing.T) {
	tests := []struct {
		name  string
		tools []ClaudeTool
		want  int
	}{
		{name: "nil", want: maxClaudeWebSearchUses},
		{name: "omitted", tools: []ClaudeTool{nativeWebSearchTool()}, want: maxClaudeWebSearchUses},
		{name: "lowered", tools: []ClaudeTool{{Type: "web_search_20250305", Name: webSearchToolName, MaxUses: 2}, bashClaudeTool()}, want: 2},
		{name: "capped", tools: []ClaudeTool{{Type: "web_search_20250305", Name: webSearchToolName, MaxUses: 99}}, want: maxClaudeWebSearchUses},
		{name: "client max_uses ignored", tools: []ClaudeTool{{Name: "other", MaxUses: 1}}, want: maxClaudeWebSearchUses},
	}
	for _, tt := range tests {
		if got := resolveClaudeWebSearchMaxUses(tt.tools); got != tt.want {
			t.Errorf("%s: got %d, want %d", tt.name, got, tt.want)
		}
	}
}

func TestConvertClaudeToolsReplacesNativeWebSearch(t *testing.T) {
	kiroTools, _ := convertClaudeTools([]ClaudeTool{nativeWebSearchTool(), bashClaudeTool()})
	var sawBash bool
	var webSearch []KiroToolWrapper
	for _, tool := range kiroTools {
		switch tool.ToolSpecification.Name {
		case kiroWebSearchToolName:
			webSearch = append(webSearch, tool)
		case "bash":
			sawBash = true
		}
	}
	if !sawBash || len(webSearch) != 1 {
		t.Fatalf("expected Bash and one web_search tool, got %+v", kiroTools)
	}
	schema, _ := webSearch[0].ToolSpecification.InputSchema.JSON.(map[string]interface{})
	props, _ := schema["properties"].(map[string]interface{})
	if props["query"] == nil {
		t.Fatalf("web_search schema has no query: %+v", schema)
	}

	//! Claude Code's own WebSearch tool has the same Kiro name, so it replaces the native one.
	shadowed, nameMap := convertClaudeTools([]ClaudeTool{nativeWebSearchTool(), {Name: "WebSearch", Description: "client search tool", InputSchema: map[string]interface{}{"type": "object"}}})
	if len(shadowed) != 1 || nameMap[kiroWebSearchToolName] != "WebSearch" {
		t.Fatalf("client WebSearch must replace the native one, got %+v (nameMap=%v)", shadowed, nameMap)
	}
}

func TestWebSearchPageAge(t *testing.T) {
	if got := webSearchPageAge("1710000000000"); got != "March 9, 2024" {
		t.Fatalf("epoch ms page_age = %v", got)
	}
	if got := webSearchPageAge("2 days ago"); got != "2 days ago" {
		t.Fatalf("text page_age = %v", got)
	}
	if got := webSearchPageAge(" "); got != nil {
		t.Fatalf("empty page_age = %v", got)
	}
}

func TestGenerateWebSearchSummaryTruncatesByRune(t *testing.T) {
	summary := generateWebSearchSummary("q", []WebSearchResult{{Title: "T", URL: "https://e.com", Snippet: strings.Repeat("é", 250)}})
	if !strings.Contains(summary, strings.Repeat("é", 200)+"...") || strings.Contains(summary, strings.Repeat("é", 201)) {
		t.Fatalf("snippet must be cut at 200 runes: %q", summary)
	}
	if !strings.Contains(summary, "Source: https://e.com") {
		t.Fatalf("summary misses source: %q", summary)
	}
	if empty := generateWebSearchSummary("q", nil); !strings.Contains(empty, "No results found.") {
		t.Fatalf("empty summary = %q", empty)
	}
}

func TestChunkByRunesKeepsMultibyteIntact(t *testing.T) {
	chunks := chunkByRunes("héllo wörld", 3)
	if strings.Join(chunks, "") != "héllo wörld" || len(chunks) != 4 {
		t.Fatalf("chunks = %q", chunks)
	}
	if chunkByRunes("", 3) != nil {
		t.Fatal("empty text must give no chunks")
	}
}

func TestAppendWebSearchRoundSurvivesClaudeToKiro(t *testing.T) {
	//! Regression from upstream: the appended round must keep the tool_use / tool_result pair for Kiro.
	req := &ClaudeRequest{
		Model:    "claude-sonnet-4.5",
		Messages: []ClaudeMessage{{Role: "user", Content: "search something"}},
		Tools:    []ClaudeTool{nativeWebSearchTool(), bashClaudeTool()},
	}
	round := &claudeWebSearchRound{
		text:     "Looking it up.",
		toolUses: []KiroToolUse{{ToolUseID: "toolu_ws_1", Name: webSearchToolName, Input: map[string]interface{}{"query": "golang generics"}}},
	}
	outcomes := []webSearchOutcome{{query: "golang generics", results: []WebSearchResult{{Title: "Generics", URL: "https://go.dev", Snippet: "Go 1.18"}}}}
	appendWebSearchRound(req, round, round.toolUses, outcomes)

	if len(req.Messages) != 3 {
		t.Fatalf("messages = %d, want user + assistant + tool_result", len(req.Messages))
	}
	payload := ClaudeToKiro(req, false)
	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx == nil || len(ctx.ToolResults) != 1 || ctx.ToolResults[0].ToolUseID != "toolu_ws_1" {
		t.Fatalf("tool result lost: %+v", ctx)
	}
	if text := ctx.ToolResults[0].Content[0].Text; !strings.Contains(text, "golang generics") || !strings.Contains(text, "https://go.dev") {
		t.Fatalf("tool result text = %q", text)
	}
	history := payload.ConversationState.History
	last := history[len(history)-1].AssistantResponseMessage
	if last == nil || len(last.ToolUses) != 1 || last.ToolUses[0].ToolUseID != "toolu_ws_1" {
		t.Fatalf("history tool_use lost: %+v", last)
	}
}

func TestWebSearchToolResultHistoryBecomesText(t *testing.T) {
	var msg ClaudeMessage
	if err := json.Unmarshal([]byte(`{"role":"assistant","content":[
		{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"q"}},
		{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"Go","url":"https://go.dev"}]},
		{"type":"text","text":"Answer."}
	]}`), &msg); err != nil {
		t.Fatal(err)
	}
	text, toolUses := extractClaudeAssistantContent(msg.Content)
	if len(toolUses) != 0 {
		t.Fatalf("server tool blocks must not become Kiro tool uses: %+v", toolUses)
	}
	if !strings.Contains(text, "Go (https://go.dev)") || !strings.Contains(text, "Answer.") {
		t.Fatalf("history text = %q", text)
	}
}

type mcpSearchStub struct {
	calls   atomic.Int32
	queries chan string
}

func stubMCPWebSearch(t *testing.T, status int, body string) *mcpSearchStub {
	//! stubMCPWebSearch answers every MCP call; any other REST call fails the test.
	t.Helper()
	stub := &mcpSearchStub{queries: make(chan string, 16)}
	old := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/mcp" {
			t.Errorf("unexpected REST call %s", req.URL)
			return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}
		stub.calls.Add(1)
		var rpc struct {
			Params struct {
				Arguments struct {
					Query string `json:"query"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(req.Body).Decode(&rpc)
		stub.queries <- rpc.Params.Arguments.Query
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})})
	t.Cleanup(func() { kiroRestHttpStore.Store(old) })
	return stub
}

const mcpOneResult = `{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"Go Release\",\"url\":\"https://go.dev/doc\",\"snippet\":\"Go 1.26 is out\",\"publishedDate\":1710000000000}]}"}]}}`

func webSearchToolUseFrame(t *testing.T, id, query string) []byte {
	t.Helper()
	return awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": id,
		"name":      kiroWebSearchToolName,
		"input":     `{"query":"` + query + `"}`,
		"stop":      true,
	})
}

func postClaudeMessages(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
	return rec
}

func decodeClaudeMessage(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &msg); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	return msg
}

func contentTypes(msg map[string]interface{}) []string {
	blocks, _ := msg["content"].([]interface{})
	types := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		block, _ := raw.(map[string]interface{})
		blockType, _ := block["type"].(string)
		types = append(types, blockType)
	}
	return types
}

func webSearchRequests(msg map[string]interface{}) float64 {
	usage, _ := msg["usage"].(map[string]interface{})
	serverUse, _ := usage["server_tool_use"].(map[string]interface{})
	n, _ := serverUse["web_search_requests"].(float64)
	return n
}

func TestClaudeDirectWebSearchSkipsModel(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("direct web search must not call the model")
	})
	stub := stubMCPWebSearch(t, http.StatusOK, mcpOneResult)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"Perform a web search for the query: go release"}]}`))

	if got := strings.Join(contentTypes(msg), ","); got != "text,server_tool_use,web_search_tool_result,text" {
		t.Fatalf("content types = %s", got)
	}
	if query := <-stub.queries; query != "go release" {
		t.Fatalf("MCP query = %q", query)
	}
	blocks := msg["content"].([]interface{})
	use := blocks[1].(map[string]interface{})
	result := blocks[2].(map[string]interface{})
	if !strings.HasPrefix(use["id"].(string), "srvtoolu_") || result["tool_use_id"] != use["id"] {
		t.Fatalf("server tool ids do not pair: %v / %v", use["id"], result["tool_use_id"])
	}
	first := result["content"].([]interface{})[0].(map[string]interface{})
	if first["url"] != "https://go.dev/doc" || first["page_age"] != "March 9, 2024" {
		t.Fatalf("search result block = %+v", first)
	}
	if msg["stop_reason"] != "end_turn" || webSearchRequests(msg) != 1 {
		t.Fatalf("stop_reason=%v web_search_requests=%v", msg["stop_reason"], webSearchRequests(msg))
	}
}

func TestClaudeDirectWebSearchFailureReturnsError(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("direct web search must not call the model")
	})
	stubMCPWebSearch(t, http.StatusForbidden, `{"message":"denied"}`)

	rec := postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"Perform a web search for the query: go"}]}`)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "Web search failed") {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	//! An MCP 403 must not ban the account: chat on the same account still works.
	if account := testAccount(t); !account.Enabled || account.BanStatus != "" {
		t.Fatalf("MCP failure changed account health: enabled=%v ban=%q", account.Enabled, account.BanStatus)
	}
}

func TestClaudeDirectWebSearchStreamsServerToolBlocks(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("direct web search must not call the model")
	})
	stubMCPWebSearch(t, http.StatusOK, mcpOneResult)

	rec := postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,"stream":true,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"Perform a web search for the query: go"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	var names []string
	var serverStart, serverDelta map[string]interface{}
	for _, event := range strings.Split(strings.TrimSpace(rec.Body.String()), "\n\n") {
		var name, data string
		for _, line := range strings.Split(event, "\n") {
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			}
			if v, ok := strings.CutPrefix(line, "data: "); ok {
				data = v
			}
		}
		names = append(names, name)
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			t.Fatalf("bad SSE data %q: %v", data, err)
		}
		if index, _ := payload["index"].(float64); index == 1 {
			switch name {
			case "content_block_start":
				serverStart, _ = payload["content_block"].(map[string]interface{})
			case "content_block_delta":
				serverDelta, _ = payload["delta"].(map[string]interface{})
			}
		}
	}
	if names[0] != "message_start" || names[len(names)-1] != "message_stop" || names[len(names)-2] != "message_delta" {
		t.Fatalf("event order = %v", names)
	}
	if serverStart["type"] != "server_tool_use" || len(serverStart["input"].(map[string]interface{})) != 0 {
		t.Fatalf("server_tool_use start = %+v", serverStart)
	}
	if serverDelta["type"] != "input_json_delta" || serverDelta["partial_json"] != `{"query":"go"}` {
		t.Fatalf("server_tool_use delta = %+v", serverDelta)
	}
}

func TestClaudeWebSearchLoopFeedsResultsBackToModel(t *testing.T) {
	var upstreamCalls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
		switch upstreamCalls.Add(1) {
		case 1:
			if ctx == nil || len(ctx.Tools) != 1 || ctx.Tools[0].ToolSpecification.Name != kiroWebSearchToolName {
				t.Errorf("first round must offer the web_search function tool: %+v", ctx)
			}
			writeFrames(w, webSearchToolUseFrame(t, "toolu_ws_1", "go release"), meteringFrame(t))
		case 2:
			if ctx == nil || len(ctx.ToolResults) != 1 || !strings.Contains(ctx.ToolResults[0].Content[0].Text, "Go Release") {
				t.Errorf("second round must carry the search result: %+v", ctx)
			}
			writeKiroTextResponse(t, w, "Go 1.26 is the latest.")
		default:
			t.Error("unexpected extra model call")
		}
	})
	stub := stubMCPWebSearch(t, http.StatusOK, mcpOneResult)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"What is the latest Go?"}]}`))

	if got := strings.Join(contentTypes(msg), ","); got != "server_tool_use,web_search_tool_result,text" {
		t.Fatalf("content types = %s", got)
	}
	if upstreamCalls.Load() != 2 || stub.calls.Load() != 1 {
		t.Fatalf("model calls=%d MCP calls=%d", upstreamCalls.Load(), stub.calls.Load())
	}
	if msg["stop_reason"] != "end_turn" || webSearchRequests(msg) != 1 {
		t.Fatalf("stop_reason=%v web_search_requests=%v", msg["stop_reason"], webSearchRequests(msg))
	}
}

func TestClaudeWebSearchLoopReturnsClientToolUse(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
			"toolUseId": "toolu_bash",
			"name":      "Bash",
			"input":     `{"command":"ls"}`,
			"stop":      true,
		}), meteringFrame(t))
	})
	stub := stubMCPWebSearch(t, http.StatusOK, mcpOneResult)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"},{"name":"Bash","description":"run","input_schema":{"type":"object"}}],
		"messages":[{"role":"user","content":"list files"}]}`))

	if got := strings.Join(contentTypes(msg), ","); got != "tool_use" {
		t.Fatalf("content types = %s", got)
	}
	if msg["stop_reason"] != "tool_use" || stub.calls.Load() != 0 {
		t.Fatalf("stop_reason=%v MCP calls=%d", msg["stop_reason"], stub.calls.Load())
	}
}

func TestClaudeWebSearchLoopStopsAtMaxUses(t *testing.T) {
	var upstreamCalls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		//! A model that never stops searching must still end after max_uses+2 rounds.
		upstreamCalls.Add(1)
		writeFrames(w, webSearchToolUseFrame(t, "toolu_ws", "again"), meteringFrame(t))
	})
	stub := stubMCPWebSearch(t, http.StatusOK, mcpOneResult)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}],
		"messages":[{"role":"user","content":"keep searching"}]}`))

	if upstreamCalls.Load() != 3 || stub.calls.Load() != 1 || webSearchRequests(msg) != 1 {
		t.Fatalf("model calls=%d MCP calls=%d web_search_requests=%v", upstreamCalls.Load(), stub.calls.Load(), webSearchRequests(msg))
	}
	if !bytes.Contains(mustJSON(t, msg["content"]), []byte(`"error_code":"max_uses_exceeded"`)) {
		t.Fatalf("expected max_uses_exceeded result, got %v", msg["content"])
	}
	if msg["stop_reason"] != "end_turn" {
		t.Fatalf("stop_reason = %v", msg["stop_reason"])
	}
}

func TestClaudeWebSearchLoopPassesSearchErrorToModel(t *testing.T) {
	var upstreamCalls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if upstreamCalls.Add(1) == 1 {
			writeFrames(w, webSearchToolUseFrame(t, "toolu_ws_1", "go"), meteringFrame(t))
			return
		}
		ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
		if ctx == nil || len(ctx.ToolResults) != 1 || !strings.Contains(ctx.ToolResults[0].Content[0].Text, "web_search failed (unavailable)") {
			t.Errorf("model must see the search failure: %+v", ctx)
		}
		writeKiroTextResponse(t, w, "Search is down; from memory: Go 1.x.")
	})
	stubMCPWebSearch(t, http.StatusInternalServerError, `oops`)

	msg := decodeClaudeMessage(t, postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"latest go?"}]}`))

	if !bytes.Contains(mustJSON(t, msg["content"]), []byte(`"error_code":"unavailable"`)) {
		t.Fatalf("expected unavailable result block, got %v", msg["content"])
	}
	if account := testAccount(t); !account.Enabled || account.BanStatus != "" {
		t.Fatalf("MCP failure changed account health: enabled=%v ban=%q", account.Enabled, account.BanStatus)
	}
}

func mustJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

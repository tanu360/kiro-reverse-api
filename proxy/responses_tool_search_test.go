package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const clientToolSearchDeclaration = `{"type":"tool_search","execution":"client","description":"Search deferred tools.","parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"number"}},"required":["query"]}}`

func TestResponsesClientToolSearchRoundTrip(t *testing.T) {
	var req OpenAIResponsesRequest
	if err := json.Unmarshal([]byte(`{"model":"claude-sonnet-4.5","input":"find my linear issues","tools":[`+clientToolSearchDeclaration+`]}`), &req); err != nil {
		t.Fatal(err)
	}
	p, msg := prepareResponsesRequest(&req, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	if len(p.OpenAIRequest.Tools) != 1 || p.OpenAIRequest.Tools[0].Function.Name != "tool_search" {
		t.Fatalf("tool_search not declared to the model: %+v", p.OpenAIRequest.Tools)
	}
	if p.OpenAIRequest.Tools[0].Function.Description != "Search deferred tools." {
		t.Fatalf("tool_search description lost: %q", p.OpenAIRequest.Tools[0].Function.Description)
	}

	call := KiroToolUse{ToolUseID: "call_search", Name: "tool_search", Input: map[string]interface{}{"query": "linear issues", "limit": float64(5)}}
	response, _ := buildResponsesCompletedObject(p, "", "", []KiroToolUse{call}, 10, 3)
	item := response["output"].([]map[string]interface{})[0]
	if item["type"] != "tool_search_call" || item["execution"] != "client" || item["call_id"] != "call_search" {
		t.Fatalf("tool_search call item: %+v", item)
	}
	if _, isString := item["arguments"].(string); isString {
		t.Fatalf("Codex reads tool_search arguments as an object, got %+v", item["arguments"])
	}
	if _, hasName := item["name"]; hasName {
		t.Fatalf("tool_search_call carries no name: %+v", item)
	}

	searchOutput := map[string]interface{}{
		"type": "tool_search_output", "call_id": "call_search", "status": "completed", "execution": "client",
		"tools": []interface{}{map[string]interface{}{
			"type": "namespace", "name": "mcp__linear", "description": "Linear",
			"tools": []interface{}{map[string]interface{}{"type": "function", "name": "list_issues", "description": "List issues", "parameters": map[string]interface{}{"type": "object"}}},
		}},
	}
	next, _ := json.Marshal(map[string]interface{}{
		"model": "claude-sonnet-4.5",
		"tools": []json.RawMessage{json.RawMessage(clientToolSearchDeclaration)},
		"input": []interface{}{map[string]interface{}{"role": "user", "content": "find my linear issues"}, item, searchOutput},
	})
	req = OpenAIResponsesRequest{}
	if err := json.Unmarshal(next, &req); err != nil {
		t.Fatal(err)
	}
	p, msg = prepareResponsesRequest(&req, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	names := map[string]bool{}
	for _, tool := range p.OpenAIRequest.Tools {
		names[tool.Function.Name] = true
	}
	if !names["tool_search"] || !names["mcp__linear__list_issues"] {
		t.Fatalf("searched tools not callable: %+v", names)
	}
	var toolCall *ToolCall
	var result *OpenAIMessage
	for i := range p.CurrentMessages {
		m := &p.CurrentMessages[i]
		if len(m.ToolCalls) == 1 {
			toolCall = &m.ToolCalls[0]
		}
		if m.Role == "tool" {
			result = m
		}
	}
	if toolCall == nil || toolCall.ID != "call_search" || toolCall.Function.Name != "tool_search" || !strings.Contains(toolCall.Function.Arguments, `"linear issues"`) {
		t.Fatalf("tool_search call lost from history: %+v", p.CurrentMessages)
	}
	if result == nil || result.ToolCallID != "call_search" || !strings.Contains(extractOpenAIMessageText(result.Content), "mcpLinearListIssues") {
		t.Fatalf("tool_search result lost from history: %+v", p.CurrentMessages)
	}

	found := KiroToolUse{ToolUseID: "call_list", Name: "mcp__linear__list_issues", Input: map[string]interface{}{}}
	response, _ = buildResponsesCompletedObject(p, "", "", []KiroToolUse{found}, 10, 3)
	item = response["output"].([]map[string]interface{})[0]
	if item["type"] != "function_call" || item["name"] != "list_issues" || item["namespace"] != "mcp__linear" {
		t.Fatalf("searched tool call: %+v", item)
	}
}

func TestResponsesHostedToolSearchIgnored(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"search"`),
		Tools: []OpenAIResponsesTool{{Type: "tool_search"}},
	}
	p, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	if len(p.OpenAIRequest.Tools) != 0 {
		t.Fatalf("hosted tool_search has no executor here, got %+v", p.OpenAIRequest.Tools)
	}
}

func TestResponsesToolSearchCallSSE(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var p KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			t.Error(err)
			return
		}
		tools := p.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools
		if len(tools) != 1 {
			t.Errorf("tools = %d", len(tools))
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_search", "name": tools[0].ToolSpecification.Name, "input": `{"query":"gmail"}`, "stop": true}), meteringFrame(t))
	})
	body := `{"model":"claude-sonnet-4.5","stream":true,"store":false,"input":"read my mail","tools":[` + clientToolSearchDeclaration + `]}`
	rec := httptest.NewRecorder()
	h.handleOpenAIResponses(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if strings.Contains(out, "response.function_call_arguments") {
		t.Fatalf("tool_search_call must not stream function argument events: %s", out)
	}
	var done map[string]interface{}
	for _, event := range parseResponsesSSE(t, out) {
		if event.Name == "response.output_item.done" {
			done = responseSSEMap(t, event.Data["item"])
		}
	}
	if done == nil || done["type"] != "tool_search_call" || done["execution"] != "client" {
		t.Fatalf("tool_search_call item missing: %s", out)
	}
	if args, ok := done["arguments"].(map[string]interface{}); !ok || args["query"] != "gmail" {
		t.Fatalf("tool_search arguments: %+v", done["arguments"])
	}
}

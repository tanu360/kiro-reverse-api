package proxy

import (
	"encoding/json"
	"errors"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdditionalToolsCustomNamespaceRoundTrip(t *testing.T) {
	var req OpenAIResponsesRequest
	if err := json.Unmarshal([]byte(`{"model":"claude-sonnet-4.5","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec"},{"type":"namespace","name":"collaboration","tools":[{"type":"function","name":"spawn_agent","parameters":{"type":"object","properties":{"message":{"type":"string","encrypted":true}}}}]}]},{"role":"user","content":"run a task"}]}`), &req); err != nil {
		t.Fatal(err)
	}
	p, msg := prepareResponsesRequest(&req, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	if len(p.OpenAIRequest.Tools) != 2 {
		t.Fatalf("tool declarations lost: %+v", p.OpenAIRequest.Tools)
	}
	payload := OpenAIToKiro(&p.OpenAIRequest, false)
	b, _ := json.Marshal(payload)
	if strings.Contains(string(b), `"encrypted"`) {
		t.Fatal("transport-only schema keyword reached Kiro")
	}
	tools := []KiroToolUse{{ToolUseID: "call_exec", Name: "exec", Input: map[string]interface{}{"input": "print('hi')"}}, {ToolUseID: "call_spawn", Name: "collaboration__spawn_agent", Input: map[string]interface{}{"message": "hi"}}}
	response, _ := buildResponsesCompletedObject(p, "", "", tools, 10, 3)
	output := response["output"].([]map[string]interface{})
	if output[0]["type"] != "custom_tool_call" || output[0]["input"] != "print('hi')" {
		t.Fatalf("custom output: %+v", output[0])
	}
	if output[1]["name"] != "spawn_agent" || output[1]["namespace"] != "collaboration" {
		t.Fatalf("namespace output: %+v", output[1])
	}
	input, _ := json.Marshal([]interface{}{output[0], output[1], map[string]interface{}{"type": "custom_tool_call_output", "call_id": "call_exec", "output": "hi"}, map[string]interface{}{"type": "function_call_output", "call_id": "call_spawn", "output": "done"}})
	messages, err := responsesInputToMessages(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 3 || len(messages[0].ToolCalls) != 2 || messages[0].ToolCalls[1].Function.Name != "collaboration__spawn_agent" || messages[1].ToolCallID != "call_exec" {
		t.Fatalf("history round trip: %+v", messages)
	}
}

func TestResponsesCustomToolHTTPAndSSE(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[stream], func(t *testing.T) {
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
				writeFrames(w, awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_exec", "name": tools[0].ToolSpecification.Name, "input": `{"input":"echo hello"}`, "stop": true}), meteringFrame(t))
			})
			body := `{"model":"claude-sonnet-4.5","stream":STREAM,"input":[{"type":"additional_tools","role":"developer","tools":[{"type":"custom","name":"exec"}]},{"role":"user","content":"run"}]}`
			body = strings.ReplaceAll(body, "STREAM", map[bool]string{false: "false", true: "true"}[stream])
			rec := httptest.NewRecorder()
			h.handleOpenAIResponses(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
			if rec.Code != 200 {
				t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"type":"custom_tool_call"`) || !strings.Contains(rec.Body.String(), `"input":"echo hello"`) {
				t.Fatalf("custom call missing: %s", rec.Body.String())
			}
			if stream && (!strings.Contains(rec.Body.String(), "response.custom_tool_call_input.delta") || !strings.Contains(rec.Body.String(), "response.completed")) {
				t.Fatal("custom SSE lifecycle missing")
			}
		})
	}
}

func TestResponsesToolDeclarationsValidationAndAgentInput(t *testing.T) {
	for _, input := range []string{`[{"type":"additional_tools","tools":"bad"},{"role":"user","content":"hi"}]`, `[{"type":"additional_tools"},{"role":"user","content":"hi"}]`} {
		if _, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: "claude-sonnet-4.5", Input: json.RawMessage(input)}, nil); msg == "" {
			t.Fatal("malformed declarations silently ignored")
		}
	}
	input := json.RawMessage(`[{"type":"additional_tools","tools":[{"type":"function","name":"run"}]},{"type":"agent_message","content":[{"type":"input_text","text":"first task"},{"type":"encrypted_content","encrypted_content":"plaintext task from a non-encrypted client"}]}]`)
	p, msg := prepareResponsesRequest(&OpenAIResponsesRequest{Model: "claude-sonnet-4.5", Input: input, Tools: []OpenAIResponsesTool{{Type: "function", Name: "run"}}}, nil)
	if msg != "" || len(p.OpenAIRequest.Tools) != 1 || len(p.CurrentMessages) != 1 || p.CurrentMessages[0].Role != "user" {
		t.Fatalf("dedupe/agent task: %s %+v", msg, p)
	}
	if !strings.Contains(extractOpenAIMessageText(p.CurrentMessages[0].Content), "plaintext task") {
		t.Fatal("agent task lost")
	}
}

func TestClaudeToolChoiceSelectionAndWebSearch(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", Messages: []ClaudeMessage{{Role: "user", Content: "run"}}, Tools: []ClaudeTool{{Name: "a/b"}, {Name: "other"}, {Type: "web_search_20250305", Name: "web_search"}}}
	for _, kind := range []string{"any", "tool"} {
		req.ToolChoice = map[string]interface{}{"type": kind, "name": "a/b"}
		p := ClaudeToKiro(req, false)
		current := p.ConversationState.CurrentMessage.UserInputMessage
		if !strings.Contains(current.Content, "client requires") {
			t.Fatal("required tool choice dropped")
		}
		if kind == "tool" && len(current.UserInputMessageContext.Tools) != 1 {
			t.Fatal("unselected tools still advertised")
		}
	}
	req.ToolChoice = map[string]interface{}{"type": "tool", "name": "missing"}
	if validateClaudeRequestShape(req) == "" {
		t.Fatal("undeclared tool accepted")
	}
	req.ToolChoice = map[string]interface{}{"type": "none"}
	if mode, _ := claudeWebSearchModeFor(req); mode != claudeWebSearchNone {
		t.Fatal("none still triggers native search")
	}
}

func TestStopReasonVariantsAndToolInputIsolation(t *testing.T) {
	for _, key := range []string{"stopReason", "stop_reason", "finishReason", "finish_reason"} {
		var reason string
		err := parseFrames(t, &KiroStreamCallback{OnStopReason: func(v string) { reason = v }}, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}), awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"metadata": map[string]interface{}{key: "max_tokens"}}))
		if err != nil || reason != "max_tokens" {
			t.Fatalf("%s: %v %s", key, err, reason)
		}
	}
	if eventStopReason(map[string]interface{}{"input": map[string]interface{}{"stopReason": "end_turn"}}) != "" {
		t.Fatal("tool argument mistaken for metadata")
	}
}

func TestFreshInstallRejectsKnownAdminPassword(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	h := &Handler{}
	for _, password := range []string{"", "changeme", config.GetPassword()} {
		req := httptest.NewRequest("GET", "/admin/api/model-mappings", nil)
		req.Header.Set("X-Admin-Password", password)
		rec := httptest.NewRecorder()
		h.handleAdminAPI(rec, req)
		want := 401
		if password == config.GetPassword() {
			want = 200
		}
		if rec.Code != want {
			t.Fatalf("admin auth got %d want %d", rec.Code, want)
		}
	}
}

func TestConfiguredAliasesAdvertisedWithExactPrecedence(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateModelMappings([]config.ModelMappingRule{{Key: "alias", Value: "claude-haiku-4.5"}, {Key: "alias-pro", Value: "claude-opus-4.8"}, {Key: "alias-pro-thinking", Value: "claude-sonnet-4.5"}}); err != nil {
		t.Fatal(err)
	}
	for input, want := range map[string]string{"alias-pro": "claude-opus-4.8", "alias-pro-thinking": "claude-sonnet-4.5"} {
		got, _ := ParseModelAndThinking(input, "-thinking")
		if got != want {
			t.Fatalf("%s resolved %s", input, got)
		}
	}
	if _, thinking := ParseModelAndThinking("plain", ""); thinking {
		t.Fatal("empty suffix enabled thinking")
	}
	models := appendConfiguredModelAliases([]map[string]interface{}{buildModelInfo("claude-opus-4.8", "anthropic", true)}, "-thinking")
	seen := map[string]bool{}
	for _, model := range models {
		id := model["id"].(string)
		if seen[id] {
			t.Fatal("duplicate model")
		}
		seen[id] = true
		if id == "alias-pro" && model["supports_image"] != true {
			t.Fatal("alias lost vision capability")
		}
	}
	if !seen["alias-pro"] || !seen["alias-pro-thinking"] {
		t.Fatal("aliases absent from discovery")
	}
}

func TestContextUsageAloneDoesNotCompleteStream(t *testing.T) {
	err := parseFrames(t, &KiroStreamCallback{}, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}), awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 1}))
	if !errors.Is(err, errUpstreamTruncatedResponse) {
		t.Fatalf("context occupancy accepted as completion: %v", err)
	}
}

func TestClaudeToolChoiceNoneDoesNotAdvertiseTools(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4.5", Messages: []ClaudeMessage{{Role: "user", Content: "hello"}}, Tools: []ClaudeTool{{Name: "run", InputSchema: map[string]interface{}{"type": "object"}}}, ToolChoice: map[string]interface{}{"type": "none"}}
	p := ClaudeToKiro(req, false)
	ctx := p.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx != nil && len(ctx.Tools) > 0 {
		t.Fatal("tool_choice none ignored")
	}
}

// Codex declares apply_patch as a freeform tool with a Lark grammar. Kiro only
// accepts JSON schemas, so the grammar must survive in the description.
func TestCustomToolGrammarReachesKiro(t *testing.T) {
	var req OpenAIResponsesRequest
	body := `{"model":"claude-sonnet-4.5","input":[{"type":"additional_tools","role":"developer","tools":[` +
		`{"type":"custom","name":"apply_patch","description":"Edit files.","format":{"type":"grammar","syntax":"lark","definition":"start: begin_patch hunk+ end_patch"}},` +
		`{"type":"custom","name":"exec","format":{"type":"text"}}]},{"role":"user","content":"patch it"}]}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	p, msg := prepareResponsesRequest(&req, nil)
	if msg != "" {
		t.Fatal(msg)
	}
	descriptions := map[string]string{}
	for _, tool := range p.OpenAIRequest.Tools {
		descriptions[tool.Function.Name] = tool.Function.Description
	}
	want := "Edit files.\n\nThe input string must match this lark grammar:\nstart: begin_patch hunk+ end_patch"
	if descriptions["apply_patch"] != want {
		t.Fatalf("apply_patch description = %q", descriptions["apply_patch"])
	}
	if descriptions["exec"] != "" {
		t.Fatalf("text-format tool gained a grammar hint: %q", descriptions["exec"])
	}
}

// Issue #151: Codex v0.146 sends every tool inside an additional_tools input
// item. Kiro sees sanitized names, so namespaced calls must come back to Codex
// as {name, namespace}, or Codex rejects them with "unsupported call".
func TestIssue151CodexPayloadRoundTripsThroughKiro(t *testing.T) {
	const mcpNamespace = "mcp__chrome_devtools_extended_server"
	const mcpTool = "take_full_page_accessibility_snapshot_with_options"
	body := `{"model":"claude-sonnet-4.5","stream":STREAM,"tool_choice":"auto","parallel_tool_calls":false,"input":[` +
		`{"type":"additional_tools","role":"developer","tools":[` +
		`{"type":"custom","name":"exec","description":"Run JavaScript code to orchestrate tool calls."},` +
		`{"type":"function","name":"wait","parameters":{"type":"object","properties":{"ms":{"type":"number"}}}},` +
		`{"type":"function","name":"request_user_input","parameters":{"type":"object","properties":{"prompt":{"type":"string"}}}},` +
		`{"type":"namespace","name":"collaboration","description":"Sub-agent tools.","tools":[` +
		`{"type":"function","name":"followup_task","parameters":{"type":"object","properties":{"message":{"type":"string","encrypted":true}}}},` +
		`{"type":"function","name":"interrupt_agent","parameters":{"type":"object","properties":{"id":{"type":"string"}}}}]},` +
		`{"type":"namespace","name":"` + mcpNamespace + `","tools":[{"type":"function","name":"` + mcpTool + `"}]}]},` +
		`{"role":"user","content":"which files are in this directory"}]}`

	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[stream], func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				var p KiroPayload
				if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
					t.Error(err)
					return
				}
				declared := map[string]bool{}
				for _, tool := range p.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools {
					name := tool.ToolSpecification.Name
					if len(name) > 64 || strings.Contains(name, "__") {
						t.Errorf("Kiro received an unsanitized tool name %q", name)
					}
					declared[name] = true
				}
				if len(declared) != 6 {
					t.Errorf("Kiro saw %d tools, want 6: %v", len(declared), declared)
					return
				}
				var mcpName string
				for name := range declared {
					if strings.HasPrefix(name, "mcpChrome") {
						mcpName = name
					}
				}
				if !declared["exec"] || !declared["collaborationFollowupTask"] || mcpName == "" {
					t.Errorf("expected tools missing: %v", declared)
					return
				}
				writeFrames(w,
					awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_exec", "name": "exec", "input": `{"input":"ls"}`, "stop": true}),
					awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_follow", "name": "collaborationFollowupTask", "input": `{"message":"go"}`, "stop": true}),
					awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "call_mcp", "name": mcpName, "input": `{}`, "stop": true}),
					meteringFrame(t))
			})
			rec := httptest.NewRecorder()
			req := strings.ReplaceAll(body, "STREAM", map[bool]string{false: "false", true: "true"}[stream])
			h.handleOpenAIResponses(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(req)))
			if rec.Code != 200 {
				t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
			}

			var output []map[string]interface{}
			if stream {
				for _, line := range strings.Split(rec.Body.String(), "\n") {
					data, ok := strings.CutPrefix(line, "data: ")
					if !ok {
						continue
					}
					var event struct {
						Type     string `json:"type"`
						Response struct {
							Output []map[string]interface{} `json:"output"`
						} `json:"response"`
					}
					if json.Unmarshal([]byte(data), &event) == nil && event.Type == "response.completed" {
						output = event.Response.Output
					}
				}
			} else {
				var resp struct {
					Output []map[string]interface{} `json:"output"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
					t.Fatal(err)
				}
				output = resp.Output
			}
			if len(output) != 3 {
				t.Fatalf("output items = %d: %s", len(output), rec.Body.String())
			}
			if output[0]["type"] != "custom_tool_call" || output[0]["name"] != "exec" || output[0]["input"] != "ls" {
				t.Errorf("exec call: %+v", output[0])
			}
			if output[1]["type"] != "function_call" || output[1]["name"] != "followup_task" || output[1]["namespace"] != "collaboration" {
				t.Errorf("namespaced call: %+v", output[1])
			}
			if output[2]["name"] != mcpTool || output[2]["namespace"] != mcpNamespace {
				t.Errorf("long MCP call: %+v", output[2])
			}
		})
	}
}

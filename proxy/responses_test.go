package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func resetResponsesPersistenceForTest(t *testing.T) {
	t.Helper()
}

func TestResponsesInputStringToKiro(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"hello responses"`),
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	payload := OpenAIToKiro(&prepared.OpenAIRequest, false)

	if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != "hello responses" {
		t.Fatalf("expected input string as current user content, got %q", got)
	}
}

func TestResponsesInputItemsAndInstructions(t *testing.T) {
	previous := []OpenAIMessage{
		{Role: "user", Content: "first user"},
		{Role: "assistant", Content: "first assistant"},
	}
	req := &OpenAIResponsesRequest{
		Model:              "claude-sonnet-4.5",
		PreviousResponseID: "resp_prev",
		Instructions:       "current instructions only",
		Input: json.RawMessage(`[
		  {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},
		  {"type":"function_call_output","call_id":"call_1","output":"tool output"}
		]`),
	}

	prepared, msg := prepareResponsesRequest(req, previous)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	if len(prepared.StoredMessages) != 4 {
		t.Fatalf("expected previous + current messages only in stored state, got %d", len(prepared.StoredMessages))
	}
	for _, msg := range prepared.StoredMessages {
		if msg.Role == "system" {
			t.Fatalf("instructions must not be stored as conversation history")
		}
	}
	foundInstructions := false
	for _, message := range prepared.OpenAIRequest.Messages {
		if message.Role == "system" && message.Content == "current instructions only" {
			foundInstructions = true
		}
	}
	if !foundInstructions {
		t.Fatalf("expected instructions to be added to Kiro request")
	}
	if prepared.OpenAIRequest.Messages[len(prepared.OpenAIRequest.Messages)-1].Role != "tool" {
		t.Fatalf("expected function_call_output to become tool message")
	}
}

func TestResponsesJSONSchemaTextFormatAddsInstruction(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"return json"`),
		Text: &OpenAIResponsesText{Format: map[string]interface{}{
			"type": "json_schema",
			"name": "answer",
			"schema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"answer": map[string]interface{}{"type": "string"},
				},
			},
		}},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	foundFormatInstruction := false
	for _, message := range prepared.OpenAIRequest.Messages {
		if message.Role == "system" && strings.Contains(extractOpenAIMessageText(message.Content), "valid JSON matching this JSON schema") {
			foundFormatInstruction = true
		}
	}
	if !foundFormatInstruction {
		t.Fatalf("expected json_schema format instruction, got %#v", prepared.OpenAIRequest.Messages)
	}
}

func TestResponsesFunctionToolsConvertToKiroTools(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"weather"`),
		Tools: []OpenAIResponsesTool{{
			Type:        "function",
			Name:        "get_weather",
			Description: "Get weather",
			Parameters:  map[string]interface{}{"type": "object"},
		}},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	payload := OpenAIToKiro(&prepared.OpenAIRequest, false)

	ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
	if ctx == nil || len(ctx.Tools) != 1 {
		t.Fatalf("expected one converted tool")
	}
	if got := ctx.Tools[0].ToolSpecification.Name; got != "getWeather" {
		t.Fatalf("expected converted tool name, got %q", got)
	}
}

func TestResponsesHostedToolConvertsToWebSearchFunction(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"search"`),
		Tools: []OpenAIResponsesTool{{Type: "web_search"}},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	if len(prepared.OpenAIRequest.Tools) != 1 {
		t.Fatalf("expected hosted tool to convert, got %#v", prepared.OpenAIRequest.Tools)
	}
	if got := prepared.OpenAIRequest.Tools[0].Function.Name; got != webSearchToolName {
		t.Fatalf("expected web_search function name, got %q", got)
	}
}

func TestResponsesFutureUnknownToolIgnored(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"search"`),
		Tools: []OpenAIResponsesTool{{Type: "local_shell_preview", Name: "local_shell"}},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	if len(prepared.OpenAIRequest.Tools) != 0 {
		t.Fatalf("expected future unknown tool to be ignored, got %#v", prepared.OpenAIRequest.Tools)
	}
}

func TestResponsesNamespaceToolFlattensFunctions(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"weather"`),
		Tools: []OpenAIResponsesTool{{
			Type: "namespace",
			Name: "tools",
			Tools: []OpenAIResponsesTool{{
				Type:        "function",
				Name:        "get_weather",
				Description: "Get weather",
				Parameters:  map[string]interface{}{"type": "object"},
			}},
		}},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	if len(prepared.OpenAIRequest.Tools) != 1 {
		t.Fatalf("expected one flattened function tool, got %#v", prepared.OpenAIRequest.Tools)
	}
	if got := prepared.OpenAIRequest.Tools[0].Function.Name; got != "tools__get_weather" {
		t.Fatalf("expected flattened tool name, got %q", got)
	}
}

func TestResponsesNamespaceToolQualifiesDuplicateChildren(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"click"`),
		Tools: []OpenAIResponsesTool{
			{
				Type: "namespace",
				Name: "mcp__computer_use",
				Tools: []OpenAIResponsesTool{{
					Type:       "function",
					Name:       "click",
					Parameters: map[string]interface{}{"type": "object"},
				}},
			},
			{
				Type: "namespace",
				Name: "mcp__lightpanda",
				Tools: []OpenAIResponsesTool{{
					Type:       "function",
					Name:       "click",
					Parameters: map[string]interface{}{"type": "object"},
				}},
			},
		},
	}

	prepared, msg := prepareResponsesRequest(req, nil)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	if len(prepared.OpenAIRequest.Tools) != 2 {
		t.Fatalf("expected two tools, got %#v", prepared.OpenAIRequest.Tools)
	}
	names := []string{
		prepared.OpenAIRequest.Tools[0].Function.Name,
		prepared.OpenAIRequest.Tools[1].Function.Name,
	}
	if names[0] == names[1] {
		t.Fatalf("expected qualified names to be unique, got %#v", names)
	}
	if names[0] != "mcp__computer_use__click" || names[1] != "mcp__lightpanda__click" {
		t.Fatalf("unexpected qualified names %#v", names)
	}
}

func TestResponsesHandlerAcceptsHostedTool(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "searched")
	})

	rec := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","input":"search","tools":[{"type":"web_search"}]}`
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "searched") {
		t.Fatalf("expected upstream response, got %s", rec.Body.String())
	}
}

func TestResponsesWebSearchEmulationRunsMCPFollowup(t *testing.T) {
	upstreamCalls := 0
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode Kiro payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		if upstreamCalls == 1 {
			ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
			if ctx == nil || len(ctx.Tools) != 1 || ctx.Tools[0].ToolSpecification.Name != kiroWebSearchToolName {
				t.Fatalf("expected web_search tool in first payload, got %#v", ctx)
			}
			_, _ = w.Write(bytes.Join([][]byte{
				awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
					"toolUseId": "ws_1",
					"name":      kiroWebSearchToolName,
					"input":     `{"query":"kiro latest"}`,
					"stop":      true,
				}),
				awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 1}),
				awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
			}, nil))
			return
		}
		if upstreamCalls == 2 {
			ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext
			if ctx == nil || len(ctx.ToolResults) != 1 {
				t.Fatalf("expected MCP tool result in follow-up payload, got %#v", ctx)
			}
			if got := ctx.ToolResults[0].Content[0].Text; !strings.Contains(got, "Kiro Search Result") {
				t.Fatalf("expected formatted search result, got %q", got)
			}
			writeKiroTextResponse(t, w, "answer after search")
			return
		}
		t.Fatalf("unexpected extra upstream call %d", upstreamCalls)
	})

	oldRest := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/mcp" {
			t.Fatalf("expected MCP path, got %s", req.URL.Path)
		}
		body := `{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"Kiro Search Result\",\"url\":\"https://example.com\",\"snippet\":\"fresh data\",\"publishedDate\":1710000000}]}"}]}}`
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})})
	t.Cleanup(func() { kiroRestHttpStore.Store(oldRest) })

	rec := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","input":"search","tools":[{"type":"web_search"}]}`
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if upstreamCalls != 2 {
		t.Fatalf("expected initial and follow-up upstream calls, got %d", upstreamCalls)
	}
	if !strings.Contains(rec.Body.String(), "answer after search") {
		t.Fatalf("expected follow-up answer, got %s", rec.Body.String())
	}
}

func TestResponsesNonStreamStoresRetrievesAndDeletes(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "hello from responses")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"hello"}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}

	var created map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	id, _ := created["id"].(string)
	if !strings.HasPrefix(id, "resp_") {
		t.Fatalf("expected resp_ id, got %q", id)
	}
	if got := created["output_text"]; got != "hello from responses" {
		t.Fatalf("expected output_text, got %#v", got)
	}

	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/v1/responses/"+id, nil))
	if getRec.Code != http.StatusOK {
		t.Fatalf("retrieve status=%d body=%s", getRec.Code, getRec.Body.String())
	}

	delRec := httptest.NewRecorder()
	h.ServeHTTP(delRec, httptest.NewRequest(http.MethodDelete, "/v1/responses/"+id, nil))
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", delRec.Code, delRec.Body.String())
	}

	missRec := httptest.NewRecorder()
	h.ServeHTTP(missRec, httptest.NewRequest(http.MethodGet, "/v1/responses/"+id, nil))
	if missRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d body=%s", missRec.Code, missRec.Body.String())
	}
}

func TestResponsesStoreFalseNotRetrievableOrChainable(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "ephemeral")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"hello","store":false}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	var created map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	id, _ := created["id"].(string)

	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/v1/responses/"+id, nil))
	if getRec.Code != http.StatusNotFound {
		t.Fatalf("expected store:false response to be unavailable, got %d", getRec.Code)
	}

	chainRec := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","previous_response_id":"` + id + `","input":"next"}`
	h.ServeHTTP(chainRec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if chainRec.Code != http.StatusBadRequest {
		t.Fatalf("expected previous_response_id failure, got %d body=%s", chainRec.Code, chainRec.Body.String())
	}
}

func TestResponsesPreviousResponseIDContinuesConversation(t *testing.T) {
	var payloads []KiroPayload
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode Kiro payload: %v", err)
		}
		payloads = append(payloads, payload)
		if len(payloads) == 1 {
			writeKiroTextResponse(t, w, "first answer")
			return
		}
		writeKiroTextResponse(t, w, "second answer")
	})

	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"first"}`)))
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	var created map[string]interface{}
	_ = json.Unmarshal(first.Body.Bytes(), &created)
	id, _ := created["id"].(string)

	second := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","previous_response_id":"` + id + `","input":"second"}`
	h.ServeHTTP(second, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	if len(payloads) != 2 {
		t.Fatalf("expected two upstream payloads, got %d", len(payloads))
	}
	history := payloads[1].ConversationState.History
	if len(history) == 0 {
		t.Fatalf("expected previous conversation in history")
	}
	foundAssistant := false
	for _, item := range history {
		if item.AssistantResponseMessage != nil && strings.Contains(item.AssistantResponseMessage.Content, "first answer") {
			foundAssistant = true
		}
	}
	if !foundAssistant {
		t.Fatalf("expected first response to be restored into history, got %#v", history)
	}
}

func TestResponsesContinuationInstructionsFollowPreviousHistory(t *testing.T) {
	previous := []OpenAIMessage{
		{Role: "user", Content: "first user"},
		{Role: "assistant", Content: "first assistant"},
	}
	req := &OpenAIResponsesRequest{
		Model:              "claude-sonnet-4.5",
		PreviousResponseID: "resp_prev",
		Instructions:       "speak only French",
		Input:              json.RawMessage(`"second user"`),
	}

	prepared, msg := prepareResponsesRequest(req, previous)
	if msg != "" {
		t.Fatalf("unexpected validation error: %s", msg)
	}
	messages := prepared.OpenAIRequest.Messages
	if len(messages) != 4 {
		t.Fatalf("expected previous, instructions, and current message, got %#v", messages)
	}
	if messages[0].Role != "user" || messages[1].Role != "assistant" {
		t.Fatalf("expected previous history first, got %#v", messages)
	}
	if messages[2].Role != "system" || messages[2].Content != "speak only French" {
		t.Fatalf("expected continuation instructions after history, got %#v", messages)
	}
}

func TestResponsesInputIgnoresHostedOutputItems(t *testing.T) {
	msgs, err := responsesInputToMessages(json.RawMessage(`[
		{"type":"web_search_call","id":"ws_1","status":"completed"},
		{"type":"output_text","text":"prior assistant"},
		{"type":"input_text","text":"next user"}
	]`))
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected hosted output to be ignored, got %#v", msgs)
	}
	if msgs[0].Role != "assistant" || msgs[0].Content != "prior assistant" {
		t.Fatalf("expected output_text assistant message, got %#v", msgs[0])
	}
	if msgs[1].Role != "user" || msgs[1].Content != "next user" {
		t.Fatalf("expected input_text user message, got %#v", msgs[1])
	}
}

func TestResponsesInputIgnoresFutureUnknownTypedItems(t *testing.T) {
	msgs, err := responsesInputToMessages(json.RawMessage(`[
		{"type":"local_shell_call","id":"call_future","status":"completed"},
		{"type":"future_reasoning_trace","summary":[]},
		{"type":"future_message","role":"user","content":"kept because role is explicit"},
		{"type":"input_text","text":"next user"}
	]`))
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected unknown artifacts to be ignored and role/input messages kept, got %#v", msgs)
	}
	if msgs[0].Role != "user" || msgs[0].Content != "kept because role is explicit" {
		t.Fatalf("expected role-bearing unknown item to be kept, got %#v", msgs[0])
	}
	if msgs[1].Role != "user" || msgs[1].Content != "next user" {
		t.Fatalf("expected input_text user message, got %#v", msgs[1])
	}
}

func TestResponsesStreamEvents(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "streamed text")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"hello","stream":true}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"event: response.created", "event: response.output_text.delta", "event: response.completed"} {
		if !strings.Contains(body, want) {
			t.Fatalf("expected stream body to contain %q, got:\n%s", want, body)
		}
	}
}

func TestResponsesStreamToolBeforeTextKeepsOutputIDsAndIndexesStable(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes.Join([][]byte{
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
				"toolUseId": "call_1",
				"name":      "get_weather",
				"input":     `{"city":"Delhi"}`,
				"stop":      true,
			}),
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "tool result text"}),
			awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 1}),
			awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
		}, nil))
	})

	rec := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","input":"use tool","stream":true,"store":false,"tools":[{"type":"function","name":"get_weather","parameters":{"type":"object"}}]}`
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", rec.Code, rec.Body.String())
	}

	events := parseResponsesSSE(t, rec.Body.String())
	var toolAdded, messageAdded, messageDone, delta, completed map[string]interface{}
	for _, event := range events {
		switch event.Name {
		case "response.output_item.added":
			item := responseSSEMap(t, event.Data["item"])
			switch item["type"] {
			case "function_call":
				toolAdded = event.Data
			case "message":
				messageAdded = event.Data
			}
		case "response.output_item.done":
			item := responseSSEMap(t, event.Data["item"])
			if item["type"] == "message" {
				messageDone = event.Data
			}
		case "response.output_text.delta":
			delta = event.Data
		case "response.completed":
			completed = event.Data
		}
	}
	if toolAdded == nil || messageAdded == nil || messageDone == nil || delta == nil || completed == nil {
		t.Fatalf("missing expected stream events: %#v", events)
	}

	toolItem := responseSSEMap(t, toolAdded["item"])
	if got := responseSSEInt(t, toolAdded["output_index"]); got != 0 {
		t.Fatalf("expected first tool output_index 0, got %d", got)
	}
	if got := toolItem["id"]; got != "call_1" {
		t.Fatalf("expected tool id call_1, got %#v", got)
	}

	messageItem := responseSSEMap(t, messageAdded["item"])
	messageDoneItem := responseSSEMap(t, messageDone["item"])
	if got := responseSSEInt(t, messageAdded["output_index"]); got != 1 {
		t.Fatalf("expected later message output_index 1, got %d", got)
	}
	if got := responseSSEInt(t, messageDone["output_index"]); got != 1 {
		t.Fatalf("expected message done output_index 1, got %d", got)
	}
	if got := responseSSEInt(t, delta["output_index"]); got != 1 {
		t.Fatalf("expected text delta output_index 1, got %d", got)
	}
	if delta["item_id"] != messageItem["id"] {
		t.Fatalf("expected delta item_id %q, got %#v", messageItem["id"], delta["item_id"])
	}
	if messageDoneItem["id"] != messageItem["id"] {
		t.Fatalf("expected message done id %q, got %#v", messageItem["id"], messageDoneItem["id"])
	}

	response := responseSSEMap(t, completed["response"])
	output := responseSSESlice(t, response["output"])
	if len(output) < 2 {
		t.Fatalf("expected tool and message output items, got %#v", output)
	}
	first := responseSSEMap(t, output[0])
	second := responseSSEMap(t, output[1])
	if first["type"] != "function_call" || first["id"] != "call_1" {
		t.Fatalf("expected completed output[0] to be call_1 function_call, got %#v", first)
	}
	if second["type"] != "message" || second["id"] != messageItem["id"] {
		t.Fatalf("expected completed output[1] to reuse streamed message id %q, got %#v", messageItem["id"], second)
	}
}

type responsesSSEEvent struct {
	Name string
	Data map[string]interface{}
}

func parseResponsesSSE(t *testing.T, body string) []responsesSSEEvent {
	t.Helper()
	var events []responsesSSEEvent
	for _, block := range strings.Split(body, "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		var name string
		var dataText string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				dataText = strings.TrimPrefix(line, "data: ")
			}
		}
		if name == "" || dataText == "" {
			t.Fatalf("invalid SSE block: %q", block)
		}
		var data map[string]interface{}
		if err := json.Unmarshal([]byte(dataText), &data); err != nil {
			t.Fatalf("decode SSE data %s: %v", dataText, err)
		}
		events = append(events, responsesSSEEvent{Name: name, Data: data})
	}
	return events
}

func responseSSEMap(t *testing.T, value interface{}) map[string]interface{} {
	t.Helper()
	m, ok := value.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map, got %#v", value)
	}
	return m
}

func responseSSESlice(t *testing.T, value interface{}) []interface{} {
	t.Helper()
	s, ok := value.([]interface{})
	if !ok {
		t.Fatalf("expected slice, got %#v", value)
	}
	return s
}

func responseSSEInt(t *testing.T, value interface{}) int {
	t.Helper()
	f, ok := value.(float64)
	if !ok {
		t.Fatalf("expected number, got %#v", value)
	}
	return int(f)
}

func newResponsesTestHandler(t *testing.T, upstream http.HandlerFunc) *Handler {
	t.Helper()
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config init: %v", err)
	}
	resetResponsesPersistenceForTest(t)
	if err := config.AddAccount(config.Account{
		ID:          "responses-account",
		Enabled:     true,
		AccessToken: "token-responses",
		ProfileArn:  "arn:aws:codewhisperer:profile/responses",
	}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	if err := config.UpdatePreferredEndpoint("kiro"); err != nil {
		t.Fatalf("set preferred endpoint: %v", err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatalf("disable endpoint fallback: %v", err)
	}

	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	oldEndpoints := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: server.URL, Origin: "AI_EDITOR", Name: "responses-test"}}
	t.Cleanup(func() { kiroEndpoints = oldEndpoints })

	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Timeout: time.Second, Transport: &http.Transport{}})
	t.Cleanup(func() { kiroHttpStore.Store(oldClient) })

	p := accountpool.GetPool()
	p.Reload()
	p.RecordSuccess("responses-account")
	return &Handler{
		pool:        p,
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
		startTime:   time.Now().Unix(),
	}
}

func writeKiroTextResponse(t *testing.T, w http.ResponseWriter, text string) {
	t.Helper()
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": text}),
		awsEventStreamFrame(t, "contextUsageEvent", map[string]interface{}{"contextUsagePercentage": 1}),
		awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.01}),
	}, nil))
}

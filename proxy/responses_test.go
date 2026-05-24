package proxy

import (
	"bytes"
	"encoding/json"
	"kiro-proxy/config"
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
	closeResponsesDB()
	t.Cleanup(closeResponsesDB)
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
	if prepared.OpenAIRequest.Messages[0].Role != "system" {
		t.Fatalf("expected instructions to be added to Kiro request")
	}
	if prepared.OpenAIRequest.Messages[len(prepared.OpenAIRequest.Messages)-1].Role != "tool" {
		t.Fatalf("expected function_call_output to become tool message")
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
	if got := ctx.Tools[0].ToolSpecification.Name; got != "get_weather" {
		t.Fatalf("expected converted tool name, got %q", got)
	}
}

func TestResponsesUnsupportedToolRejected(t *testing.T) {
	req := &OpenAIResponsesRequest{
		Model: "claude-sonnet-4.5",
		Input: json.RawMessage(`"search"`),
		Tools: []OpenAIResponsesTool{{Type: "web_search_preview"}},
	}

	_, msg := prepareResponsesRequest(req, nil)
	if !strings.Contains(msg, "unsupported Responses tool type") {
		t.Fatalf("expected unsupported tool error, got %q", msg)
	}
}

func TestResponsesHandlerRejectsUnsupportedHostedTool(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Fatalf("unsupported tool request should not reach upstream")
	})

	rec := httptest.NewRecorder()
	body := `{"model":"claude-sonnet-4.5","input":"search","tools":[{"type":"web_search_preview"}]}`
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsupported Responses tool type") {
		t.Fatalf("expected unsupported tool message, got %s", rec.Body.String())
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

	closeResponsesDB()
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
	if err := config.Init(filepath.Join(dir, "config.json")); err != nil {
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

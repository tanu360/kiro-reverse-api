package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	fixtureSignature = "sig-abc"
	fixtureRedacted  = "ZW5jcnlwdGVk"
)

// signedReasoningFrames records the shape Kiro streams for signed reasoning: text deltas,
// the block's signature as its own event, then one redacted block before the answer.
func signedReasoningFrames(t *testing.T, tail ...[]byte) [][]byte {
	t.Helper()
	frames := [][]byte{
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "plan "}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "it"}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"signature": fixtureSignature}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": fixtureRedacted}),
	}
	frames = append(frames, tail...)
	return append(frames,
		awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn"}),
		meteringFrame(t),
	)
}

func answerFrame(t *testing.T, text string) []byte {
	t.Helper()
	return awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": text})
}

func weatherToolFrame(t *testing.T) []byte {
	t.Helper()
	return awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": "call_weather", "name": "get_weather", "input": `{"city":"Delhi"}`, "stop": true,
	})
}

// claudeSSESummary flattens a /v1/messages stream into "kind:index:detail" steps.
func claudeSSESummary(t *testing.T, body string) []string {
	t.Helper()
	var steps []string
	for _, event := range parseResponsesSSE(t, body) {
		switch event.Name {
		case "content_block_start":
			block := responseSSEMap(t, event.Data["content_block"])
			step := fmt.Sprintf("start:%d:%s", responseSSEInt(t, event.Data["index"]), block["type"])
			if data, ok := block["data"].(string); ok {
				step += ":" + data
			}
			steps = append(steps, step)
		case "content_block_delta":
			delta := responseSSEMap(t, event.Data["delta"])
			value := ""
			for _, key := range []string{"thinking", "text", "signature", "partial_json"} {
				if v, ok := delta[key].(string); ok {
					value = v
				}
			}
			steps = append(steps, fmt.Sprintf("delta:%d:%s:%s", responseSSEInt(t, event.Data["index"]), delta["type"], value))
		case "content_block_stop":
			steps = append(steps, fmt.Sprintf("stop:%d", responseSSEInt(t, event.Data["index"])))
		}
	}
	return steps
}

func postThinkingClaude(t *testing.T, h *Handler, stream bool, display string, messages []interface{}) *httptest.ResponseRecorder {
	t.Helper()
	thinkingCfg := map[string]interface{}{"type": "enabled", "budget_tokens": 1024}
	if display != "" {
		thinkingCfg["display"] = display
	}
	body := map[string]interface{}{
		"model": "claude-sonnet-4.5", "max_tokens": 2048, "stream": stream, "thinking": thinkingCfg,
		"tools":    []interface{}{map[string]interface{}{"name": "get_weather", "description": "weather", "input_schema": map[string]interface{}{"type": "object"}}},
		"messages": messages,
	}
	if messages == nil {
		body["messages"] = []interface{}{map[string]interface{}{"role": "user", "content": "weather in Delhi?"}}
	}
	raw, _ := json.Marshal(body)
	return postClaudeMessages(t, h, string(raw))
}

func TestParseEventStreamReasoningSignatureAndRedacted(t *testing.T) {
	var got []string
	err := parseFrames(t, &KiroStreamCallback{
		OnText: func(text string, isThinking bool) {
			if isThinking {
				got = append(got, "thinking:"+text)
			} else {
				got = append(got, "text:"+text)
			}
		},
		OnThinkingSignature: func(signature string) { got = append(got, "signature:"+signature) },
		OnRedactedThinking:  func(data string) { got = append(got, "redacted:"+data) },
	}, signedReasoningFrames(t, answerFrame(t, "answer"))...)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []string{"thinking:plan ", "thinking:it", "signature:" + fixtureSignature, "redacted:" + fixtureRedacted, "text:answer"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("callbacks = %q, want %q", got, want)
	}
}

func TestParseEventStreamReasoningExtrasNilCallbacksNoOp(t *testing.T) {
	var text, thinking string
	frames := signedReasoningFrames(t, answerFrame(t, "answer"))
	//! A non-string signature or redactedContent is ignored, not a decode failure.
	frames = append([][]byte{awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"signature": 42, "redactedContent": map[string]interface{}{"x": 1}})}, frames...)
	err := parseFrames(t, &KiroStreamCallback{OnText: func(s string, isThinking bool) {
		if isThinking {
			thinking += s
		} else {
			text += s
		}
	}}, frames...)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if thinking != "plan it" || text != "answer" {
		t.Fatalf("thinking=%q text=%q", thinking, text)
	}
}

func redactedOnlyFrames(t *testing.T, stopReason string) [][]byte {
	t.Helper()
	frames := [][]byte{awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": fixtureRedacted})}
	if stopReason != "" {
		frames = append(frames, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": stopReason}))
	}
	return append(frames, meteringFrame(t))
}

func TestParseEventStreamRedactedOnlyCountsWhenDelivered(t *testing.T) {
	//! Redacted reasoning counts as output only for a caller that delivers it; for any other
	//! caller a turn that sent nothing else must stay an empty stream, so it is retried.
	delivered := func() *KiroStreamCallback { return &KiroStreamCallback{OnRedactedThinking: func(string) {}} }
	for _, tc := range []struct {
		name     string
		callback *KiroStreamCallback
		stop     string
		want     error
	}{
		{"delivered, no stop reason", delivered(), "", errUpstreamTruncatedResponse},
		{"delivered, end_turn", delivered(), "end_turn", nil},
		{"dropped, no stop reason", &KiroStreamCallback{}, "", errEmptyKiroStream},
		{"dropped, end_turn", &KiroStreamCallback{}, "end_turn", errEmptyKiroStream},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := parseFrames(t, tc.callback, redactedOnlyFrames(t, tc.stop)...); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// redactedOnlyThenAnswer serves a turn with only redacted reasoning and end_turn, then a plain answer.
func redactedOnlyThenAnswer(t *testing.T, calls *atomic.Int32) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writeFrames(w, redactedOnlyFrames(t, "end_turn")...)
			return
		}
		writeFrames(w, answerFrame(t, "second try"), meteringFrame(t))
	}
}

func TestRedactedOnlyTurnRetriedWhereClientCannotSeeIt(t *testing.T) {
	requests := map[string]string{
		"/v1/chat/completions": `{"model":"claude-sonnet-4.5-thinking","stream":%t,"messages":[{"role":"user","content":"hi"}]}`,
		"/v1/responses":        `{"model":"claude-sonnet-4.5-thinking","stream":%t,"store":false,"input":"hi"}`,
		"/v1/messages think":   `{"model":"claude-sonnet-4.5","max_tokens":2048,"stream":%t,"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"hi"}]}`,
		"/v1/messages off":     `{"model":"claude-sonnet-4.5","max_tokens":64,"stream":%t,"messages":[{"role":"user","content":"hi"}]}`,
	}
	for name, body := range requests {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s-stream=%t", name, stream), func(t *testing.T) {
				var calls atomic.Int32
				h := newStreamTestHandler(t, redactedOnlyThenAnswer(t, &calls))
				if strings.HasSuffix(name, " think") {
					if err := config.UpdateThinkingConfig("-thinking", "reasoning_content", "think"); err != nil {
						t.Fatal(err)
					}
				}
				path, _, _ := strings.Cut(name, " ")
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(fmt.Sprintf(body, stream))))
				got := rec.Body.String()
				if rec.Code != http.StatusOK || calls.Load() != 2 || !strings.Contains(got, "second try") || strings.Contains(got, fixtureRedacted) {
					t.Fatalf("status=%d calls=%d body=%s, want the retried answer and no redacted data", rec.Code, calls.Load(), got)
				}
			})
		}
	}
}

func TestClaudeRedactedOnlyTurnIsAnswer(t *testing.T) {
	for _, stream := range []bool{false, true} {
		var calls atomic.Int32
		h := newStreamTestHandler(t, redactedOnlyThenAnswer(t, &calls))
		rec := postThinkingClaude(t, h, stream, "", nil)
		got := rec.Body.String()
		if rec.Code != http.StatusOK || calls.Load() != 1 || !strings.Contains(got, `"redacted_thinking"`) || !strings.Contains(got, fixtureRedacted) {
			t.Fatalf("stream=%t status=%d calls=%d body=%s, want one call with a redacted_thinking block", stream, rec.Code, calls.Load(), got)
		}
	}
}

func TestClaudeStreamSignatureDeltaBeforeThinkingStop(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
	})
	rec := postThinkingClaude(t, h, true, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	want := []string{
		"start:0:thinking",
		"delta:0:thinking_delta:plan ",
		"delta:0:thinking_delta:it",
		"delta:0:signature_delta:" + fixtureSignature,
		"stop:0",
		"start:1:redacted_thinking:" + fixtureRedacted,
		"stop:1",
		"start:2:text",
		"delta:2:text_delta:answer",
		"stop:2",
	}
	if got := claudeSSESummary(t, rec.Body.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("stream steps:\n got %q\nwant %q", got, want)
	}
}

func TestClaudeStreamSignsEachInterleavedThinkingBlock(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "first", "signature": "sig-1"}),
			weatherToolFrame(t),
			awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "second"}),
			awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"signature": "sig-2"}),
			answerFrame(t, "done"),
			meteringFrame(t),
		)
	})
	rec := postThinkingClaude(t, h, true, "", nil)
	steps := strings.Join(claudeSSESummary(t, rec.Body.String()), "|")
	for _, want := range []string{
		"delta:0:thinking_delta:first|delta:0:signature_delta:sig-1|stop:0|start:1:tool_use",
		"start:2:thinking|delta:2:thinking_delta:second|delta:2:signature_delta:sig-2|stop:2|start:3:text",
	} {
		if !strings.Contains(steps, want) {
			t.Fatalf("stream steps %s\nmissing %s", steps, want)
		}
	}
}

func TestClaudeStreamOmittedDisplayKeepsSignature(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
	})
	rec := postThinkingClaude(t, h, true, "omitted", nil)
	want := []string{
		"start:0:thinking",
		"delta:0:signature_delta:" + fixtureSignature,
		"stop:0",
		"start:1:redacted_thinking:" + fixtureRedacted,
		"stop:1",
		"start:2:text",
		"delta:2:text_delta:answer",
		"stop:2",
	}
	if got := claudeSSESummary(t, rec.Body.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("stream steps:\n got %q\nwant %q", got, want)
	}
	if strings.Contains(rec.Body.String(), "plan") {
		t.Fatal("omitted thinking text leaked")
	}
}

func TestClaudeStreamTextFormatsDropSignatureAndRedacted(t *testing.T) {
	for _, format := range []string{"think", "reasoning_content"} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s-stream=%t", format, stream), func(t *testing.T) {
				h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
					writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
				})
				if err := config.UpdateThinkingConfig("-thinking", "reasoning_content", format); err != nil {
					t.Fatal(err)
				}
				rec := postThinkingClaude(t, h, stream, "", nil)
				body := rec.Body.String()
				if rec.Code != http.StatusOK || !strings.Contains(body, "answer") || !strings.Contains(body, "it") {
					t.Fatalf("status=%d body=%s", rec.Code, body)
				}
				for _, leaked := range []string{fixtureSignature, fixtureRedacted, "signature_delta", "redacted_thinking"} {
					if strings.Contains(body, leaked) {
						t.Fatalf("format %s leaked %q: %s", format, leaked, body)
					}
				}
			})
		}
	}
}

func TestClaudeStreamNoKiroSignatureUnchanged(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "plan it"}),
			answerFrame(t, "answer"),
			meteringFrame(t),
		)
	})
	rec := postThinkingClaude(t, h, true, "", nil)
	want := []string{"start:0:thinking", "delta:0:thinking_delta:plan it", "stop:0", "start:1:text", "delta:1:text_delta:answer", "stop:1"}
	if got := claudeSSESummary(t, rec.Body.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("stream steps:\n got %q\nwant %q", got, want)
	}
	msg := decodeClaudeMessage(t, postThinkingClaude(t, h, false, "", nil))
	block := responseSSEMap(t, responseSSESlice(t, msg["content"])[0])
	if _, has := block["signature"]; has || block["type"] != "thinking" {
		t.Fatalf("thinking block = %v, want no signature field", block)
	}
}

func TestClaudeNonStreamThinkingSignatureAndRedacted(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
	})
	msg := decodeClaudeMessage(t, postThinkingClaude(t, h, false, "", nil))
	if got := strings.Join(contentTypes(msg), ","); got != "thinking,redacted_thinking,text" {
		t.Fatalf("content types = %s", got)
	}
	content := responseSSESlice(t, msg["content"])
	thinkingBlock := responseSSEMap(t, content[0])
	if thinkingBlock["thinking"] != "plan it" || thinkingBlock["signature"] != fixtureSignature {
		t.Fatalf("thinking block = %v", thinkingBlock)
	}
	if redacted := responseSSEMap(t, content[1]); redacted["data"] != fixtureRedacted {
		t.Fatalf("redacted block = %v", redacted)
	}
}

func TestClaudeNonStreamThinkingOffDropsExtras(t *testing.T) {
	for _, stream := range []bool{false, true} {
		h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
			writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
		})
		rec := postClaudeMessages(t, h, fmt.Sprintf(`{"model":"claude-sonnet-4.5","max_tokens":64,"stream":%t,"messages":[{"role":"user","content":"hi"}]}`, stream))
		body := rec.Body.String()
		if rec.Code != http.StatusOK || !strings.Contains(body, "answer") {
			t.Fatalf("status=%d body=%s", rec.Code, body)
		}
		for _, leaked := range []string{fixtureSignature, fixtureRedacted, "redacted_thinking", `"thinking"`} {
			if strings.Contains(body, leaked) {
				t.Fatalf("stream=%t: thinking off leaked %q: %s", stream, leaked, body)
			}
		}
	}
}

func TestApplyClaudeThinkingExtrasWithoutThinkingBlock(t *testing.T) {
	blocks := applyClaudeThinkingExtras([]ClaudeContentBlock{{Type: "text", Text: "a"}}, "orphan", []string{"r1", "r2"})
	raw, _ := json.Marshal(blocks)
	if string(raw) != `[{"type":"redacted_thinking","data":"r1"},{"type":"redacted_thinking","data":"r2"},{"type":"text","text":"a"}]` {
		t.Fatalf("blocks = %s", raw)
	}
}

// claudeHistoryAssistants returns the converted assistant turns, without the system priming pair.
func claudeHistoryAssistants(payload *KiroPayload) []*KiroAssistantResponseMessage {
	var out []*KiroAssistantResponseMessage
	for _, msg := range payload.ConversationState.History {
		if a := msg.AssistantResponseMessage; a != nil && a.Content != "I will follow these instructions." {
			out = append(out, a)
		}
	}
	return out
}

func weatherTools() []ClaudeTool {
	return []ClaudeTool{{Name: "get_weather", Description: "weather", InputSchema: map[string]interface{}{"type": "object"}}}
}

func assertNoReasoningLeak(t *testing.T, payload *KiroPayload, secrets ...string) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	for _, secret := range append(secrets, "reasoningContent", "redacted") {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("Kiro payload carries %q: %s", secret, raw)
		}
	}
}

func TestClaudeToKiroReplaysCurrentTurnThinking(t *testing.T) {
	var calls atomic.Int32
	var second KiroPayload
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			writeFrames(w, signedReasoningFrames(t, answerFrame(t, "Checking."), weatherToolFrame(t))...)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &second); err != nil {
			t.Errorf("decode upstream payload: %v", err)
		}
		writeFrames(w, answerFrame(t, "It is sunny."), meteringFrame(t))
	})
	first := decodeClaudeMessage(t, postThinkingClaude(t, h, false, "", nil))
	if got := strings.Join(contentTypes(first), ","); got != "thinking,redacted_thinking,text,tool_use" {
		t.Fatalf("first turn content types = %s", got)
	}

	messages := []interface{}{
		map[string]interface{}{"role": "user", "content": "weather in Delhi?"},
		map[string]interface{}{"role": "assistant", "content": first["content"]},
		map[string]interface{}{"role": "user", "content": []interface{}{
			map[string]interface{}{"type": "tool_result", "tool_use_id": "call_weather", "content": "sunny"},
		}},
	}
	rec := postThinkingClaude(t, h, false, "", messages)
	if rec.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, calls.Load(), rec.Body.String())
	}
	assistants := claudeHistoryAssistants(&second)
	if len(assistants) != 1 {
		t.Fatalf("history assistants = %#v", assistants)
	}
	if got := assistants[0].Content; got != "<thinking>plan it</thinking>\n\nChecking." {
		t.Fatalf("replayed assistant content = %q", got)
	}
	if len(assistants[0].ToolUses) != 1 || assistants[0].ToolUses[0].ToolUseID != "call_weather" {
		t.Fatalf("replayed tool uses = %#v", assistants[0].ToolUses)
	}
	assertNoReasoningLeak(t, &second, fixtureSignature, fixtureRedacted)
}

func finishedTurnRequest(model string) *ClaudeRequest {
	return &ClaudeRequest{
		Model: model,
		Tools: weatherTools(),
		Messages: []ClaudeMessage{
			{Role: "user", Content: "first question"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "OLD_PLAN", "signature": "sig-old"},
				map[string]interface{}{"type": "text", "text": "first done"},
			}},
			{Role: "user", Content: "weather?"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "CURRENT_PLAN", "signature": "sig-cur"},
				map[string]interface{}{"type": "tool_use", "id": "call_weather", "name": "get_weather", "input": map[string]interface{}{"city": "Delhi"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "call_weather", "content": "sunny"},
			}},
		},
	}
}

func TestClaudeToKiroDropsFinishedTurnThinkingForOlderModels(t *testing.T) {
	for _, model := range []string{"claude-sonnet-4.5", "claude-haiku-4.5"} {
		payload := ClaudeToKiro(finishedTurnRequest(model), true)
		assistants := claudeHistoryAssistants(payload)
		if len(assistants) != 2 {
			t.Fatalf("%s: history assistants = %#v", model, assistants)
		}
		if assistants[0].Content != "first done" {
			t.Fatalf("%s: finished turn content = %q, want its thinking dropped", model, assistants[0].Content)
		}
		if assistants[1].Content != "<thinking>CURRENT_PLAN</thinking>" || len(assistants[1].ToolUses) != 1 {
			t.Fatalf("%s: current tool loop = %#v, want its thinking replayed", model, assistants[1])
		}
		assertNoReasoningLeak(t, payload, "sig-old", "sig-cur", "OLD_PLAN")
	}
}

func TestClaudeToKiroKeepsPriorThinkingForNewerModels(t *testing.T) {
	for _, model := range []string{"claude-opus-4.6", "claude-sonnet-5"} {
		payload := ClaudeToKiro(finishedTurnRequest(model), true)
		assistants := claudeHistoryAssistants(payload)
		if len(assistants) != 2 || assistants[0].Content != "<thinking>OLD_PLAN</thinking>\n\nfirst done" {
			t.Fatalf("%s: history assistants = %#v", model, assistants)
		}
		if assistants[1].Content != "<thinking>CURRENT_PLAN</thinking>" {
			t.Fatalf("%s: current tool loop = %#v", model, assistants[1])
		}
		assertNoReasoningLeak(t, payload, "sig-old", "sig-cur")
	}
}

func TestClaudeToKiroReplaysInterleavedThinkingInBlockOrder(t *testing.T) {
	content, tools := extractClaudeAssistantHistory([]interface{}{
		map[string]interface{}{"type": "thinking", "thinking": "T1", "signature": "s1"},
		map[string]interface{}{"type": "text", "text": "X"},
		map[string]interface{}{"type": "tool_use", "id": "a", "name": "get_weather", "input": map[string]interface{}{}},
		map[string]interface{}{"type": "thinking", "thinking": "T2", "signature": "s2"},
		map[string]interface{}{"type": "text", "text": "Y"},
		map[string]interface{}{"type": "thinking", "thinking": ""},
	}, true)
	if content != "<thinking>T1</thinking>\n\nX\n\n<thinking>T2</thinking>\n\nY" || len(tools) != 1 {
		t.Fatalf("content=%q tools=%#v", content, tools)
	}
}

func TestClaudeToKiroDropsRedactedThinkingHistory(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-4.5",
		Tools: weatherTools(),
		Messages: []ClaudeMessage{
			{Role: "user", Content: "weather?"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "redacted_thinking", "data": "REDACTED_SECRET"},
				map[string]interface{}{"type": "tool_use", "id": "call_weather", "name": "get_weather", "input": map[string]interface{}{}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "call_weather", "content": "sunny"},
			}},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "plan"},
				map[string]interface{}{"type": "redacted_thinking", "data": "REDACTED_SECRET_2"},
				map[string]interface{}{"type": "text", "text": "sunny it is"},
				map[string]interface{}{"type": "tool_use", "id": "call_2", "name": "get_weather", "input": map[string]interface{}{}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "text", "text": "  "},
				map[string]interface{}{"type": "tool_result", "tool_use_id": "call_2", "content": "again"},
			}},
		},
	}
	payload := ClaudeToKiro(req, true)
	assistants := claudeHistoryAssistants(payload)
	if len(assistants) != 2 {
		t.Fatalf("history assistants = %#v", assistants)
	}
	if assistants[0].Content != "" || len(assistants[0].ToolUses) != 1 {
		t.Fatalf("redacted-only assistant = %#v, want empty content and its tool use", assistants[0])
	}
	if assistants[1].Content != "<thinking>plan</thinking>\n\nsunny it is" || len(assistants[1].ToolUses) != 1 {
		t.Fatalf("assistant = %#v", assistants[1])
	}
	assertNoReasoningLeak(t, payload, "REDACTED_SECRET")
}

func TestClaudeToKiroThinkingOffMatchesLegacy(t *testing.T) {
	req := finishedTurnRequest("claude-opus-4.6")
	req.Messages[3].Content = []interface{}{
		map[string]interface{}{"type": "text", "text": "a"},
		map[string]interface{}{"type": "thinking", "thinking": "CURRENT_PLAN", "signature": "sig-cur"},
		map[string]interface{}{"type": "redacted_thinking", "data": "REDACTED"},
		map[string]interface{}{"type": "text", "text": "b"},
		map[string]interface{}{"type": "tool_use", "id": "call_weather", "name": "get_weather", "input": map[string]interface{}{"city": "Delhi"}},
	}
	payload := ClaudeToKiro(req, false)
	assistants := claudeHistoryAssistants(payload)
	if len(assistants) != 2 {
		t.Fatalf("history assistants = %#v", assistants)
	}
	for i, msgIndex := range []int{1, 3} {
		wantContent, wantTools := extractClaudeAssistantContent(req.Messages[msgIndex].Content)
		//! Tool names are rewritten for Kiro later in the pipeline; content and ids are what changed here.
		if assistants[i].Content != wantContent || len(assistants[i].ToolUses) != len(wantTools) ||
			(len(wantTools) > 0 && assistants[i].ToolUses[0].ToolUseID != wantTools[0].ToolUseID) {
			t.Fatalf("assistant %d = %#v, want legacy %q %#v", i, assistants[i], wantContent, wantTools)
		}
	}
	if assistants[1].Content != "ab" {
		t.Fatalf("legacy concatenation changed: %q", assistants[1].Content)
	}
	assertNoReasoningLeak(t, payload, "CURRENT_PLAN", "OLD_PLAN", "sig-cur")
}

func TestModelKeepsPriorThinking(t *testing.T) {
	for model, want := range map[string]bool{
		"claude-opus-4.5":            true,
		"claude-opus-4.6":            true,
		"claude-opus-4-5-20251101":   true,
		"claude-opus-4.1":            false,
		"claude-opus-4":              false,
		"claude-sonnet-4.5":          false,
		"claude-sonnet-4-5-20250929": false,
		"claude-sonnet-4.6":          true,
		"claude-sonnet-5":            true,
		"claude-haiku-4.5":           false,
		"claude-haiku-5":             true,
		"claude-3-7-sonnet-20250219": false,
		"claude-5":                   true,
		"Claude-Opus-4.7":            true,
		"claude-fable-5":             true,
		"claude-sonnet":              false,
		"auto":                       false,
		"deepseek-3.2":               false,
		"":                           false,
	} {
		if got := modelKeepsPriorThinking(model); got != want {
			t.Errorf("modelKeepsPriorThinking(%q) = %t, want %t", model, got, want)
		}
	}
}

func TestOpenAIEndpointsIgnoreSignatureAndRedacted(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s-stream=%t", path, stream), func(t *testing.T) {
				h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
					writeFrames(w, signedReasoningFrames(t, answerFrame(t, "answer"))...)
				})
				body := map[string]interface{}{"model": "claude-sonnet-4.5-thinking", "stream": stream, "store": false,
					"messages": []interface{}{map[string]interface{}{"role": "user", "content": "hello"}}, "input": "hello"}
				raw, _ := json.Marshal(body)
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw))))
				out := rec.Body.String()
				if rec.Code != http.StatusOK || !strings.Contains(out, "answer") || !strings.Contains(out, "plan ") {
					t.Fatalf("status=%d body=%s", rec.Code, out)
				}
				for _, leaked := range []string{fixtureSignature, fixtureRedacted, "redacted_thinking", "signature_delta"} {
					if strings.Contains(out, leaked) {
						t.Fatalf("%s leaked %q: %s", path, leaked, out)
					}
				}
			})
		}
	}
}

func TestAutoContinueContinuationDropsReasoningExtras(t *testing.T) {
	script := &scriptedKiro{hops: []scriptedHop{
		{thinking: []string{"plan"}, text: []string{"Part one, "}, stop: "max_tokens"},
		{thinking: []string{"more"}, text: []string{"part two."}, stop: "end_turn"},
	}}
	call := func(ctx context.Context, account *config.Account, payload *KiroPayload, cb *KiroStreamCallback) error {
		hop := len(script.payloads) + 1
		if cb.OnThinkingSignature != nil {
			cb.OnThinkingSignature(fmt.Sprintf("sig-%d", hop))
		}
		if cb.OnRedactedThinking != nil {
			cb.OnRedactedThinking(fmt.Sprintf("redacted-%d", hop))
		}
		return script.call(ctx, account, payload, cb)
	}
	rec := &continueRecorder{}
	var signatures, redacted []string
	cb := rec.callback()
	cb.OnThinkingSignature = func(s string) { signatures = append(signatures, s) }
	cb.OnRedactedThinking = func(d string) { redacted = append(redacted, d) }
	if err := runAutoContinue(context.Background(), nil, testKiroPayload(), cb, call, 3); err != nil {
		t.Fatalf("runAutoContinue: %v", err)
	}
	if len(script.payloads) != 2 || rec.text != "Part one, part two." || rec.thinking != "plan" {
		t.Fatalf("calls=%d text=%q thinking=%q", len(script.payloads), rec.text, rec.thinking)
	}
	if !reflect.DeepEqual(signatures, []string{"sig-1"}) || !reflect.DeepEqual(redacted, []string{"redacted-1"}) {
		t.Fatalf("signatures=%q redacted=%q, want only the first hop's", signatures, redacted)
	}
}

package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func initStructuredConfigForTest(t *testing.T) {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
}

func structuredTestPayload(spec *structuredOutputSpec) *KiroPayload {
	payload := testKiroPayload()
	attachStructuredOutput(payload, spec, false)
	return payload
}

func personSpec() *structuredOutputSpec {
	return &structuredOutputSpec{Kind: structuredOutputJSONSchema, Strict: true, Schema: mustSchema(personSchema), SchemaText: personSchema}
}

func runStructuredScript(t *testing.T, payload *KiroPayload, hops ...scriptedHop) (*continueRecorder, *scriptedKiro, error) {
	t.Helper()
	initStructuredConfigForTest(t)
	script := &scriptedKiro{hops: hops}
	rec := &continueRecorder{}
	err := callKiroAutoContinue(t.Context(), nil, payload, rec.callback(), script.call)
	return rec, script, err
}

func TestStructuredOutputNoRetryWhenValid(t *testing.T) {
	rec, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{"```json\n{\"name\":", "\"Ann\",\"age\":30}\n```"}, stop: "end_turn", in: 50, out: 9, credits: 0.1},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 1 {
		t.Fatalf("upstream calls = %d, want 1 for a valid answer", len(script.payloads))
	}
	if rec.text != `{"name":"Ann","age":30}` || rec.stop != "end_turn" || rec.in != 50 || rec.out != 9 || rec.credits != 0.1 {
		t.Fatalf("recorded = %#v", rec)
	}
	if script.payloads[0].StructuredOutput != nil {
		t.Fatalf("the upstream payload must not carry the spec back into the hook")
	}
}

func TestStructuredOutputSplitsInlineThinking(t *testing.T) {
	rec, _, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{thinking: []string{"event "}, text: []string{"<thinking>plan</thin", "king>\n{\"name\":\"A\",\"age\":1}"}, stop: "end_turn"},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if rec.thinking != "event plan" || rec.text != `{"name":"A","age":1}` {
		t.Fatalf("thinking=%q text=%q, want reasoning kept apart from the JSON", rec.thinking, rec.text)
	}
}

func TestStructuredOutputRetryStillInvalidReturnsBestEffort(t *testing.T) {
	rec, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{`Here: {"name":"Ann"}`}, stop: "end_turn", in: 40, out: 6, credits: 0.1},
		scriptedHop{text: []string{`Sorry: {"name":"Ann","age":"thirty"}`}, stop: "end_turn", in: 60, out: 8, credits: 0.2},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 2 {
		t.Fatalf("upstream calls = %d, want exactly one retry", len(script.payloads))
	}
	if rec.text != `{"name":"Ann","age":"thirty"}` {
		t.Fatalf("text = %q, want the retry's extracted JSON", rec.text)
	}
	if rec.in != 100 || rec.out != 14 || rec.credits < 0.3-1e-9 || rec.credits > 0.3+1e-9 || rec.stopCalls != 1 {
		t.Fatalf("usage in=%d out=%d credits=%v stopCalls=%d, want sums over both calls", rec.in, rec.out, rec.credits, rec.stopCalls)
	}
}

func TestStructuredOutputRetryUsesFirstWhenRetryHasNoJSON(t *testing.T) {
	rec, _, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{`{"name":"Ann"}`}, stop: "end_turn"},
		scriptedHop{text: []string{`I can't.`}, stop: "end_turn"},
	)
	if err != nil || rec.text != `{"name":"Ann"}` {
		t.Fatalf("text=%q err=%v, want the first answer's JSON over a retry with none", rec.text, err)
	}
	if rec.out <= 0 {
		t.Fatalf("output tokens = %d, want an estimate covering both calls when Kiro sends none", rec.out)
	}
}

func TestStructuredOutputRetryDropsItsSignatureAndRedacted(t *testing.T) {
	initStructuredConfigForTest(t)
	script := &scriptedKiro{hops: []scriptedHop{
		{thinking: []string{"first plan"}, signature: "S1", redacted: []string{"R1"}, text: []string{`{"name":"Ann"}`}, stop: "end_turn"},
		{thinking: []string{"second plan"}, signature: "S2", redacted: []string{"R2"}, text: []string{`{"name":"Ann","age":30}`}, stop: "end_turn"},
	}}
	rec := &continueRecorder{}
	var signatures, redacted []string
	cb := rec.callback()
	cb.OnThinkingSignature = func(signature string) { signatures = append(signatures, signature) }
	cb.OnRedactedThinking = func(data string) { redacted = append(redacted, data) }

	if err := callKiroAutoContinue(t.Context(), nil, structuredTestPayload(personSpec()), cb, script.call); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 2 || rec.text != `{"name":"Ann","age":30}` {
		t.Fatalf("calls=%d text=%q, want one retry and its answer", len(script.payloads), rec.text)
	}
	//! The client keeps the first attempt's thinking, so only that attempt's extras may sign it.
	if rec.thinking != "first plan" || strings.Join(signatures, ",") != "S1" || strings.Join(redacted, ",") != "R1" {
		t.Fatalf("thinking=%q signatures=%q redacted=%q, want only the first attempt's", rec.thinking, signatures, redacted)
	}
}

func TestStructuredOutputSkipsWhenToolUse(t *testing.T) {
	tool := KiroToolUse{ToolUseID: "t1", Name: "lookup", Input: map[string]interface{}{"q": "x"}}
	rec, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{"Let me look that up."}, tools: []KiroToolUse{tool}, stop: "tool_use"},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 1 || rec.text != "Let me look that up." || len(rec.tools) != 1 || rec.stop != "tool_use" {
		t.Fatalf("calls=%d text=%q tools=%d stop=%q, want the tool turn passed through", len(script.payloads), rec.text, len(rec.tools), rec.stop)
	}
}

func TestStructuredOutputNoRetryOnMaxTokens(t *testing.T) {
	rec, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{`{"name":"Ann","age":`}, stop: "max_tokens"},
		scriptedHop{text: []string{`{"name":"Ann","age":1}`}, stop: "end_turn"},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 1 || rec.stop != "max_tokens" || rec.text != `{"name":"Ann","age":` {
		t.Fatalf("calls=%d stop=%q text=%q, want the cut answer as is with no retry", len(script.payloads), rec.stop, rec.text)
	}
}

func TestStructuredOutputRetryStopReasonWithoutUpstreamReason(t *testing.T) {
	//! IdC / Enterprise accounts send no stop reason; both answers together pass max_tokens.
	payload := structuredTestPayload(personSpec())
	payload.InferenceConfig = &InferenceConfig{MaxTokens: 1024}
	rec, script, err := runStructuredScript(t, payload,
		scriptedHop{text: []string{`{"name":"Ann"}`}, in: 40, out: 600},
		scriptedHop{text: []string{`{"name":"Ann","age":30}`}, in: 60, out: 600},
	)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(script.payloads) != 2 || rec.text != `{"name":"Ann","age":30}` || rec.out != 1200 {
		t.Fatalf("calls=%d text=%q out=%d, want one retry with summed output", len(script.payloads), rec.text, rec.out)
	}
	if stop := inferMaxTokensStop(rec.stop, rec.out, 1024); isOutputCapStopReason(stop) {
		t.Fatalf("stop = %q (handler reads %q), want a complete answer", rec.stop, stop)
	}

	//! The used attempt itself reaching the cap is still a cut-off.
	payload = structuredTestPayload(personSpec())
	payload.InferenceConfig = &InferenceConfig{MaxTokens: 1024}
	rec, _, err = runStructuredScript(t, payload,
		scriptedHop{text: []string{`{"name":"Ann"}`}, out: 300},
		scriptedHop{text: []string{`{"name":"Ann","age":30}`}, out: 1024},
	)
	if err != nil || rec.text != `{"name":"Ann","age":30}` || rec.stop != "max_tokens" {
		t.Fatalf("text=%q stop=%q err=%v, want max_tokens for a used retry at the cap", rec.text, rec.stop, err)
	}
}

func TestStructuredCheckBuildsProblemsFromRootTypeMatch(t *testing.T) {
	check := checkStructuredAnswer(`{"name":"Ann"} (see [1])`, personSpec())
	if check.valid || check.text != `{"name":"Ann"}` || strings.Join(check.errs, "|") != `$: missing required property "age"` {
		t.Fatalf("check = %#v, want the near-miss object and its real problem", check)
	}
}

func TestStructuredOutputRetryUpstreamErrorKeepsFirstAnswer(t *testing.T) {
	rec, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{text: []string{"Result:\n```json\n{\"name\":\"Ann\"}\n```"}, stop: "end_turn", credits: 0.1},
		scriptedHop{err: errors.New("upstream 500"), credits: 0.05},
	)
	if err != nil {
		t.Fatalf("call: %v, want the retry error swallowed", err)
	}
	if len(script.payloads) != 2 || rec.text != `{"name":"Ann"}` || rec.stop != "end_turn" {
		t.Fatalf("calls=%d text=%q stop=%q", len(script.payloads), rec.text, rec.stop)
	}
	if rec.credits < 0.15-1e-9 {
		t.Fatalf("credits = %v, want the failed retry's credits counted too", rec.credits)
	}
}

func TestStructuredOutputFirstErrorReturnsToHandler(t *testing.T) {
	_, script, err := runStructuredScript(t, structuredTestPayload(personSpec()),
		scriptedHop{err: errors.New("throttled")},
	)
	if err == nil || len(script.payloads) != 1 {
		t.Fatalf("err=%v calls=%d, want the first call's error for the handler's retry logic", err, len(script.payloads))
	}
}

func TestStructuredOutputRetryPayload(t *testing.T) {
	spec := personSpec()
	base := structuredTestPayload(spec)
	base.StructuredOutput = nil
	next := structuredRetryPayload(base, spec, "  ", []string{`$: missing required property "age"`})
	history := next.ConversationState.History
	last := history[len(history)-1].AssistantResponseMessage
	if last == nil || last.Content != "(empty reply)" {
		t.Fatalf("history tail = %#v, want the rejected reply as the assistant turn", history[len(history)-1])
	}
	current := next.ConversationState.CurrentMessage.UserInputMessage.Content
	if !strings.Contains(current, `missing required property "age"`) || !strings.Contains(current, "Reply again with only the corrected JSON value") {
		t.Fatalf("corrective prompt = %q", current)
	}
	if len(base.ConversationState.History) != len(history)-2 {
		t.Fatalf("the base payload must stay untouched")
	}
}

// structuredUpstream answers the n-th request with answers[n] and records every request body.
func structuredUpstream(t *testing.T, bodies *[]string, answers ...string) http.HandlerFunc {
	var mu sync.Mutex
	var calls atomic.Int32
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		*bodies = append(*bodies, string(body))
		mu.Unlock()
		n := int(calls.Add(1)) - 1
		if n >= len(answers) {
			n = len(answers) - 1
		}
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answers[n]}),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn", "usage": map[string]interface{}{"inputTokens": 100 + 30*n, "outputTokens": 10 + n}}),
		)
	}
}

func TestStructuredOutputRetryOnInvalid(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, structuredUpstream(t, &bodies, `Sure! {"name":"Ann"}`, `{"name":"Ann","age":30}`))
	body := `{"model":"claude-sonnet-4.5","max_tokens":256,"messages":[{"role":"user","content":"Who is Ann?"}],
		"output_config":{"format":{"type":"json_schema","schema":` + personSchema + `}}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))

	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("status=%d err=%v body=%s", rec.Code, err, rec.Body.String())
	}
	if len(bodies) != 2 {
		t.Fatalf("upstream calls = %d, want one corrective retry", len(bodies))
	}
	if !strings.Contains(bodies[1], `Sure! {\"name\":\"Ann\"}`) || !strings.Contains(bodies[1], "did not match the required JSON output") ||
		!strings.Contains(bodies[1], `missing required property \"age\"`) {
		t.Fatalf("retry body lacks the rejected answer or the correction: %s", bodies[1])
	}
	if len(resp.Content) != 1 || resp.Content[0].Text != `{"name":"Ann","age":30}` {
		t.Fatalf("content = %#v", resp.Content)
	}
	if resp.Usage.InputTokens != 230 || resp.Usage.OutputTokens != 21 || resp.StopReason != "end_turn" {
		t.Fatalf("usage = %#v stop=%q, want both calls summed", resp.Usage, resp.StopReason)
	}
}

func TestStructuredOutputMessagesJSONSchema(t *testing.T) {
	const answer = "Here you go:\n```json\n{\"name\":\"Bo\",\"age\":4}\n```\nLet me know!"
	request := func(stream bool) string {
		raw, _ := json.Marshal(map[string]interface{}{
			"model": "claude-sonnet-4.5", "max_tokens": 256, "stream": stream,
			"messages":      []interface{}{map[string]interface{}{"role": "user", "content": "Describe Bo."}},
			"output_config": map[string]interface{}{"format": map[string]interface{}{"type": "json_schema", "schema": mustSchema(personSchema)}},
		})
		return string(raw)
	}

	var bodies []string
	h := newStreamTestHandler(t, structuredUpstream(t, &bodies, answer))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(request(false))))
	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Content) != 1 {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	value, ok := decodeJSONNumbers(resp.Content[0].Text)
	if !ok || len(validateJSONSchema(value, mustSchema(personSchema), true)) != 0 {
		t.Fatalf("content %q does not validate", resp.Content[0].Text)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], "JSON schema:") || !strings.Contains(bodies[0], structuredPrimingAck) {
		t.Fatalf("upstream calls=%d, want one call carrying the schema instruction: %v", len(bodies), bodies)
	}

	bodies = nil
	h = newStreamTestHandler(t, structuredUpstream(t, &bodies, "```json\n{\"name\":\"Bo\",\"age\":4}\n```"))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(request(true))))
	streamed := collectClaudeTextDeltas(t, rec.Body.String())
	if strings.TrimSpace(streamed) != `{"name":"Bo","age":4}` || strings.Contains(streamed, "```") {
		t.Fatalf("streamed text = %q, want the JSON without its fence", streamed)
	}
}

func TestStructuredOutputChatJSONObject(t *testing.T) {
	request := func(stream bool) string {
		raw, _ := json.Marshal(map[string]interface{}{
			"model": "claude-sonnet-4.5", "stream": stream,
			"messages":        []interface{}{map[string]interface{}{"role": "user", "content": "Give me a JSON object."}},
			"response_format": map[string]interface{}{"type": "json_object"},
		})
		return string(raw)
	}
	const fenced = "```json\n{\"ok\":true}\n```"

	var bodies []string
	h := newStreamTestHandler(t, structuredUpstream(t, &bodies, fenced))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(request(false))))
	var resp struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Choices) != 1 {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if resp.Choices[0].Message.Content != `{"ok":true}` {
		t.Fatalf("content = %q", resp.Choices[0].Message.Content)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], "single valid JSON object") {
		t.Fatalf("upstream body lacks the json_object instruction: %v", bodies)
	}

	bodies = nil
	h = newStreamTestHandler(t, structuredUpstream(t, &bodies, fenced))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(request(true))))
	streamed := collectOpenAIContentDeltas(t, rec.Body.String())
	if strings.TrimSpace(streamed) != `{"ok":true}` {
		t.Fatalf("streamed = %q, want the JSON without its fence", streamed)
	}

	bodies = nil
	h = newStreamTestHandler(t, structuredUpstream(t, &bodies, fenced))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"x"}],"response_format":{"type":"xml"}}`)))
	if rec.Code != http.StatusBadRequest || len(bodies) != 0 {
		t.Fatalf("status=%d calls=%d, want a 400 before any upstream call", rec.Code, len(bodies))
	}
}

func TestStructuredOutputResponsesNonStream(t *testing.T) {
	var bodies []string
	h := newStreamTestHandler(t, structuredUpstream(t, &bodies, "Sure:\n```json\n{\"answer\":\"yes\"}\n```"))
	body := `{"model":"claude-sonnet-4.5","input":"answer","store":false,
		"text":{"format":{"type":"json_schema","name":"answer","strict":true,"schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}}}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("status=%d err=%v body=%s", rec.Code, err, rec.Body.String())
	}
	if resp["output_text"] != `{"answer":"yes"}` || len(bodies) != 1 {
		t.Fatalf("output_text=%#v calls=%d", resp["output_text"], len(bodies))
	}
}

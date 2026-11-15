package proxy

import (
	"errors"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Event sequences recorded from POST /v1/responses on 2026-11-15 (us-east-1); response
// objects are trimmed and ids, signatures and conversation ids scrubbed.

const recordedResponsesText = `data: {"type":"response.created","sequence_number":0,"response":{"object":"response","model":"claude-haiku-4.5","reasoning":null,"metadata":{"kiro:agent_mode":"vibe","kiro:conversation_id":"conv-1"},"id":"resp_0001","status":"in_progress","incomplete_details":null,"output":[],"error":null,"usage":null}}

data: {"type":"response.in_progress","sequence_number":1,"response":{"object":"response","model":"claude-haiku-4.5","id":"resp_0001","status":"in_progress","output":[],"error":null,"usage":null}}

data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_0001","role":"assistant","status":"in_progress","content":[]}}

data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_0001","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_0001","output_index":0,"content_index":0,"delta":"p"}

data: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_0001","output_index":0,"content_index":0,"delta":"ong"}

data: {"type":"response.output_text.done","sequence_number":6,"item_id":"msg_0001","output_index":0,"content_index":0,"text":"pong"}

data: {"type":"response.content_part.done","sequence_number":7,"item_id":"msg_0001","output_index":0,"content_index":0,"part":{"type":"output_text","text":"pong","annotations":[]}}

data: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"type":"message","id":"msg_0001","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong","annotations":[]}]}}

data: {"type":"response.completed","sequence_number":9,"response":{"object":"response","model":"claude-haiku-4.5","id":"resp_0001","status":"completed","incomplete_details":null,"output":[{"type":"message","id":"msg_0001","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong","annotations":[]}]}],"error":null,"usage":{"kiro:credits":{"value":0.005392237810945275,"unit":"credit","unit_plural":"credits"},"kiro:context_usage_percentage":2.0540001}}}

data: [DONE]

`

const recordedResponsesToolCall = `data: {"type":"response.created","sequence_number":0,"response":{"object":"response","model":"claude-haiku-4.5","id":"resp_0002","status":"in_progress","output":[],"usage":null}}

data: {"type":"response.in_progress","sequence_number":1,"response":{"object":"response","model":"claude-haiku-4.5","id":"resp_0002","status":"in_progress","output":[],"usage":null}}

data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"function_call","id":"fc_0001","call_id":"tooluse_0001","name":"getWeather"}}

data: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_0001","output_index":0,"delta":""}

data: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_0001","output_index":0,"delta":"{\"city\""}

data: {"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"fc_0001","output_index":0,"delta":": \"Pari"}

data: {"type":"response.function_call_arguments.delta","sequence_number":6,"item_id":"fc_0001","output_index":0,"delta":"s\"}"}

data: {"type":"response.function_call_arguments.done","sequence_number":7,"item_id":"fc_0001","output_index":0,"arguments":"{\"city\": \"Paris\"}"}

data: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"type":"function_call","id":"fc_0001","call_id":"tooluse_0001","name":"getWeather","arguments":"{\"city\": \"Paris\"}","status":"completed"}}

data: {"type":"response.completed","sequence_number":9,"response":{"object":"response","model":"claude-haiku-4.5","id":"resp_0002","status":"completed","incomplete_details":null,"error":null,"usage":{"kiro:credits":{"value":0.008262,"unit":"credit","unit_plural":"credits"},"kiro:context_usage_percentage":2.3465}}}

data: [DONE]

`

const recordedResponsesReasoning = `data: {"type":"response.created","sequence_number":0,"response":{"object":"response","model":"claude-opus-5.5","id":"resp_0003","status":"in_progress","output":[],"usage":null}}

data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"reasoning","id":"rs_0001","status":"in_progress","summary":[],"content":[],"encrypted_content":null}}

data: {"type":"response.reasoning_part.added","sequence_number":3,"item_id":"rs_0001","output_index":0,"content_index":0,"part":{"type":"reasoning_text","text":""}}

data: {"type":"response.reasoning_text.delta","sequence_number":4,"item_id":"rs_0001","output_index":0,"content_index":0,"delta":"1"}

data: {"type":"response.reasoning_text.delta","sequence_number":5,"item_id":"rs_0001","output_index":0,"content_index":0,"delta":"001"}

data: {"type":"response.reasoning_text.delta","sequence_number":6,"item_id":"rs_0001","output_index":0,"content_index":0,"delta":" factors as 7×11×13.\n\n"}

data: {"type":"response.reasoning_text.done","sequence_number":10,"item_id":"rs_0001","output_index":0,"content_index":0,"text":"1001 factors as 7×11×13.\n\n"}

data: {"type":"response.reasoning_part.done","sequence_number":11,"item_id":"rs_0001","output_index":0,"content_index":0,"part":{"type":"reasoning_text","text":"1001 factors as 7×11×13.\n\n"}}

data: {"type":"response.output_item.done","sequence_number":12,"output_index":0,"item":{"type":"reasoning","id":"rs_0001","status":"completed","summary":[],"content":[{"type":"reasoning_text","text":"1001 factors as 7×11×13.\n\n"}],"encrypted_content":"{\"reasoningText\":{\"text\":\"1001 factors as 7×11×13.\\n\\n\",\"signature\":\"SIG-SCRUBBED\"}}"}}

data: {"type":"response.output_item.added","sequence_number":13,"output_index":1,"item":{"type":"message","id":"msg_0003","role":"assistant","status":"in_progress","content":[]}}

data: {"type":"response.output_text.delta","sequence_number":15,"item_id":"msg_0003","output_index":1,"content_index":0,"delta":"No, 1001 = 7 × 11 × 13."}

data: {"type":"response.output_text.done","sequence_number":18,"item_id":"msg_0003","output_index":1,"content_index":0,"text":"No, 1001 = 7 × 11 × 13."}

data: {"type":"response.output_item.done","sequence_number":20,"output_index":1,"item":{"type":"message","id":"msg_0003","role":"assistant","status":"completed","content":[{"type":"output_text","text":"No, 1001 = 7 × 11 × 13.","annotations":[]}]}}

data: {"type":"response.completed","sequence_number":21,"response":{"object":"response","model":"claude-opus-5.5","id":"resp_0003","status":"completed","incomplete_details":null,"error":null,"usage":{"kiro:credits":{"value":0.01599,"unit":"credit","unit_plural":"credits"},"kiro:context_usage_percentage":0.197}}}

data: [DONE]

`

type responsesStreamResult struct {
	text, thinking string
	tools          []KiroToolUse
	signatures     []string
	redacted       []string
	stopReason     string
	credits        float64
	context        []float64
}

func runResponsesStream(t *testing.T, stream string) (responsesStreamResult, bool, error) {
	t.Helper()
	var r responsesStreamResult
	emitted, err := consumeKiroEvents(responsesSSESource(strings.NewReader(stream)), &KiroStreamCallback{
		OnText: func(text string, thinking bool) {
			if thinking {
				r.thinking += text
			} else {
				r.text += text
			}
		},
		OnToolUse:           func(tu KiroToolUse) { r.tools = append(r.tools, tu) },
		OnStopReason:        func(reason string) { r.stopReason = reason },
		OnCredits:           func(c float64) { r.credits = c },
		OnContextUsage:      func(p float64) { r.context = append(r.context, p) },
		OnThinkingSignature: func(s string) { r.signatures = append(r.signatures, s) },
		OnRedactedThinking:  func(d string) { r.redacted = append(r.redacted, d) },
	})
	return r, emitted, err
}

func TestResponsesStreamRecordedText(t *testing.T) {
	r, emitted, err := runResponsesStream(t, recordedResponsesText)
	if err != nil || !emitted {
		t.Fatalf("emitted=%t err=%v", emitted, err)
	}
	if r.text != "pong" {
		t.Fatalf("text = %q, want pong (done must not repeat the deltas)", r.text)
	}
	if r.stopReason != "END_TURN" {
		t.Fatalf("stop reason = %q", r.stopReason)
	}
	if math.Abs(r.credits-0.005392237810945275) > 1e-12 {
		t.Fatalf("credits = %v", r.credits)
	}
	if len(r.context) != 1 || math.Abs(r.context[0]-2.0540001) > 1e-9 {
		t.Fatalf("context usage = %v", r.context)
	}
}

func TestResponsesStreamRecordedToolCall(t *testing.T) {
	r, _, err := runResponsesStream(t, recordedResponsesToolCall)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if len(r.tools) != 1 {
		t.Fatalf("tools = %+v", r.tools)
	}
	tu := r.tools[0]
	//! The arguments came as deltas, so done's copy must not be appended to them.
	if tu.ToolUseID != "tooluse_0001" || tu.Name != "getWeather" || tu.Input["city"] != "Paris" || len(tu.Input) != 1 {
		t.Fatalf("tool use = %+v", tu)
	}
	if r.text != "" || math.Abs(r.credits-0.008262) > 1e-12 {
		t.Fatalf("text = %q credits = %v", r.text, r.credits)
	}
}

func TestResponsesStreamRecordedReasoning(t *testing.T) {
	r, _, err := runResponsesStream(t, recordedResponsesReasoning)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if r.thinking != "1001 factors as 7×11×13.\n\n" {
		t.Fatalf("thinking = %q (the envelope must not repeat streamed text)", r.thinking)
	}
	if len(r.signatures) != 1 || r.signatures[0] != "SIG-SCRUBBED" {
		t.Fatalf("signatures = %v", r.signatures)
	}
	if r.text != "No, 1001 = 7 × 11 × 13." {
		t.Fatalf("text = %q", r.text)
	}
}

func sseLines(events ...string) string {
	var b strings.Builder
	for _, e := range events {
		b.WriteString("data: ")
		b.WriteString(e)
		b.WriteString("\n\n")
	}
	return b.String()
}

const responsesCompleted = `{"type":"response.completed","response":{"status":"completed","usage":{"kiro:credits":{"value":0.01},"kiro:context_usage_percentage":1.5}}}`

func TestResponsesStreamReasoningEnvelopeWithoutDeltas(t *testing.T) {
	stream := sseLines(
		`{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}`,
		`{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"{\"reasoningText\":{\"text\":\"think\",\"signature\":\"sig-1\"}}"}}`,
		`{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_2","encrypted_content":"{\"redactedContent\":\"b64data\"}"}}`,
		`{"type":"response.output_text.delta","item_id":"m","content_index":0,"delta":"answer"}`,
		responsesCompleted,
	)
	r, _, err := runResponsesStream(t, stream)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if r.thinking != "think" || len(r.signatures) != 1 || r.signatures[0] != "sig-1" {
		t.Fatalf("thinking = %q signatures = %v", r.thinking, r.signatures)
	}
	if len(r.redacted) != 1 || r.redacted[0] != "b64data" {
		t.Fatalf("redacted = %v", r.redacted)
	}
}

func TestResponsesStreamTextOnlyInDone(t *testing.T) {
	stream := sseLines(
		`{"type":"kiro:keep_alive"}`,
		`{"type":"response.output_text.done","item_id":"m","content_index":0,"text":"whole answer"}`,
		`{"type":"response.refusal.delta","delta":"I can"}`,
		`{"type":"response.refusal.delta","delta":"not."}`,
		`{"type":"response.refusal.done","refusal":"I cannot."}`,
		`{"type":"kiro:code_reference.added","reference":{}}`,
		responsesCompleted,
	)
	stream = ": comment\nevent: response.completed\n" + stream
	r, _, err := runResponsesStream(t, stream)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if r.text != "whole answerI cannot." {
		t.Fatalf("text = %q", r.text)
	}
}

func TestResponsesStreamToolCallVariants(t *testing.T) {
	stream := sseLines(
		// Arguments only in output_item.added.
		`{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"read","arguments":"{\"path\":\"a\"}"}}`,
		`{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"read","arguments":"{\"path\":\"a\"}","status":"completed"}}`,
		// Arguments only in output_item.done.
		`{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"list"}}`,
		`{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"list","arguments":"{\"dir\":\"b\"}","status":"completed"}}`,
		// Cut short: Kiro marks it incomplete, so it never runs.
		`{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_c","call_id":"call_c","name":"write"}}`,
		`{"type":"response.function_call_arguments.delta","item_id":"fc_c","delta":"{\"path\":"}`,
		`{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_c","call_id":"call_c","name":"write","status":"incomplete"}}`,
		// Arrives whole, with no added event before it.
		`{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_d","call_id":"call_d","name":"grep","arguments":"{\"q\":\"d\"}","status":"completed"}}`,
		`{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"kiro:credits":{"value":0.02}}}}`,
	)
	r, _, err := runResponsesStream(t, stream)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	var got []string
	for _, tu := range r.tools {
		got = append(got, tu.ToolUseID+":"+tu.Name)
	}
	if strings.Join(got, ",") != "call_a:read,call_b:list,call_d:grep" {
		t.Fatalf("tools = %v", got)
	}
	if r.tools[0].Input["path"] != "a" || r.tools[1].Input["dir"] != "b" || r.tools[2].Input["q"] != "d" {
		t.Fatalf("tool inputs = %+v", r.tools)
	}
	if r.stopReason != "MAX_TOKENS" {
		t.Fatalf("stop reason = %q", r.stopReason)
	}
}

func TestResponsesStreamIncompleteContentFilter(t *testing.T) {
	stream := sseLines(`{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}`)
	r, _, err := runResponsesStream(t, stream)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if r.stopReason != "CONTENT_FILTERED" || mapClaudeStopReason(r.stopReason, 0) != "refusal" {
		t.Fatalf("stop reason = %q", r.stopReason)
	}
}

func TestResponsesStreamTruncatedWithoutCompletion(t *testing.T) {
	stream := sseLines(`{"type":"response.output_text.delta","item_id":"m","content_index":0,"delta":"partial"}`)
	_, emitted, err := runResponsesStream(t, stream)
	if !emitted || !errors.Is(err, errUpstreamTruncatedResponse) {
		t.Fatalf("emitted=%t err=%v, want a truncation", emitted, err)
	}
}

func TestResponsesStreamErrorEvents(t *testing.T) {
	cases := []struct {
		name  string
		event string
		check func(error) bool
	}{
		{"rate limit", `{"type":"error","error":{"type":"too_many_requests","code":"rate_limit_exceeded","message":"Too many requests"}}`, func(err error) bool {
			var q *upstreamQuotaError
			return errors.As(err, &q) && q.throttled && isQuotaErrorMessage(err.Error()) && strings.Contains(err.Error(), "USER_REQUEST_RATE_EXCEEDED")
		}},
		{"code alone", `{"type":"error","code":"insufficient_quota","message":"out of credits"}`, func(err error) bool {
			var q *upstreamQuotaError
			return errors.As(err, &q) && !q.throttled && isUsageQuotaExhaustedMessage(err.Error())
		}},
		{"context", `{"type":"response.failed","response":{"status":"failed","error":{"type":"invalid_request","code":"context_length_exceeded","message":"Input is too long."}}}`, func(err error) bool {
			var c *upstreamClientError
			return errors.As(err, &c) && c.status == http.StatusBadRequest && strings.Contains(err.Error(), "CONTENT_LENGTH_EXCEEDS_THRESHOLD")
		}},
		{"overloaded", `{"type":"response.failed","response":{"error":{"type":"server_error","code":"server_is_overloaded","message":"busy"}}}`, func(err error) bool {
			return errors.Is(err, errKiroEventStreamUpstream) && strings.Contains(err.Error(), "MODEL_TEMPORARILY_UNAVAILABLE") && !isUpstreamClientError(err)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := runResponsesStream(t, sseLines(tc.event, responsesCompleted))
			if err == nil || !tc.check(err) {
				t.Fatalf("err = %v (%T)", err, err)
			}
		})
	}
}

func TestResponsesStreamRejectsBadLines(t *testing.T) {
	if _, _, err := runResponsesStream(t, "data: {not json\n\n"); !errors.Is(err, errInvalidKiroEventStream) {
		t.Fatalf("broken JSON: err = %v", err)
	}
	huge := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"" + strings.Repeat("x", maxResponsesSSELine) + "\"}\n\n"
	if _, _, err := runResponsesStream(t, huge); !errors.Is(err, errInvalidKiroEventStream) {
		t.Fatalf("line over the limit: err = %v", err)
	}
	if _, _, err := runResponsesStream(t, "data: ping\n\n"+sseLines(`{"type":"response.output_text.delta","delta":"ok"}`, responsesCompleted)); err != nil {
		t.Fatalf("non-JSON data must be skipped: %v", err)
	}
}

func TestResponsesHTTPFailureMapping(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	header := func(kv ...string) http.Header {
		h := http.Header{}
		for i := 0; i+1 < len(kv); i += 2 {
			h.Set(kv[i], kv[i+1])
		}
		return h
	}

	t.Run("throttle with kiro header", func(t *testing.T) {
		err := responsesHTTPFailure(429, header("x-amzn-kiro-ratelimit-retry-after", "1500", "Retry-After", "9"),
			[]byte(`{"error":{"message":"Too many requests","type":"too_many_requests","code":"rate_limit_exceeded"},"retryAfterMilliseconds":4000}`), now)
		var q *upstreamQuotaError
		if !errors.As(err, &q) || !q.throttled || q.retryFor != 1500*time.Millisecond {
			t.Fatalf("err = %v %+v", err, q)
		}
		if !strings.Contains(err.Error(), "HTTP 429 from Kiro Responses") || !strings.Contains(err.Error(), "USER_REQUEST_RATE_EXCEEDED") {
			t.Fatalf("message = %q", err.Error())
		}
	})
	t.Run("body wait, then Retry-After", func(t *testing.T) {
		var q *upstreamQuotaError
		err := responsesHTTPFailure(429, header("Retry-After", "9"), []byte(`{"message":"Too many requests, please wait before trying again.","reason":"USER_REQUEST_RATE_EXCEEDED","retryAfterMilliseconds":2500}`), now)
		if !errors.As(err, &q) || !q.throttled || q.retryFor != 2500*time.Millisecond {
			t.Fatalf("body wait: %v %+v", err, q)
		}
		err = responsesHTTPFailure(429, header("Retry-After", "7"), []byte(`{"error":{"code":"rate_limit_exceeded"}}`), now)
		if !errors.As(err, &q) || q.retryFor != 7*time.Second {
			t.Fatalf("Retry-After: %v %+v", err, q)
		}
	})
	t.Run("spent credits", func(t *testing.T) {
		for _, tc := range []struct {
			status int
			body   string
		}{
			{402, `{"error":{"message":"Payment required","code":"credit_balance_exhausted"}}`},
			{429, `{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}`},
			{429, `{"message":"Monthly limit reached","reason":"MONTHLY_REQUEST_COUNT"}`},
		} {
			err := responsesHTTPFailure(tc.status, http.Header{}, []byte(tc.body), now)
			var q *upstreamQuotaError
			if !errors.As(err, &q) || q.throttled || !isQuotaErrorMessage(err.Error()) {
				t.Fatalf("%d %s: err = %v %+v", tc.status, tc.body, err, q)
			}
		}
	})
	t.Run("context length", func(t *testing.T) {
		for _, tc := range []struct {
			status int
			body   string
		}{
			{413, `{"error":{"message":"Request too large"}}`},
			{400, `{"error":{"message":"Input is too long.","type":"invalid_request","code":"context_length_exceeded"}}`},
		} {
			err := responsesHTTPFailure(tc.status, http.Header{}, []byte(tc.body), now)
			var c *upstreamClientError
			if !errors.As(err, &c) || c.status != http.StatusBadRequest || !strings.Contains(err.Error(), "CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
				t.Fatalf("%d: err = %v", tc.status, err)
			}
		}
	})
	t.Run("recorded invalid tool schema", func(t *testing.T) {
		body := `{"error":{"message":"Bedrock error message: The model returned the following errors: tools.0.custom.input_schema: JSON schema is invalid.","type":"invalid_request","param":null,"code":"invalid_function_parameters"}}`
		err := responsesHTTPFailure(400, http.Header{}, []byte(body), now)
		var c *upstreamClientError
		if !errors.As(err, &c) || c.status != 400 || !strings.Contains(err.Error(), "TOOL_SCHEMA_INVALID") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("auth and server errors", func(t *testing.T) {
		err := responsesHTTPFailure(403, http.Header{}, []byte(`{"message":"User is not authorized to make this call."}`), now)
		if isUpstreamClientError(err) || !isAuthErrorMessage(err.Error()) {
			t.Fatalf("403: err = %v", err)
		}
		err = responsesHTTPFailure(500, http.Header{}, []byte(`{"error":{"message":"boom","type":"server_error"}}`), now)
		var q *upstreamQuotaError
		if isUpstreamClientError(err) || errors.As(err, &q) || !strings.Contains(err.Error(), "HTTP 500") {
			t.Fatalf("500: err = %v", err)
		}
		err = responsesHTTPFailure(404, http.Header{}, []byte(`{"error":{"code":"model_not_found","message":"no such model"}}`), now)
		if !isUpstreamClientError(err) || !strings.Contains(err.Error(), "INVALID_MODEL_ID") {
			t.Fatalf("404: err = %v", err)
		}
		err = responsesHTTPFailure(400, http.Header{}, []byte(`{"error":{"code":"kiro:model_requires_user_opt_in","message":"opt in"}}`), now)
		if !strings.Contains(err.Error(), "MODEL_REQUIRES_USER_OPT_IN") {
			t.Fatalf("opt in: err = %v", err)
		}
	})
}

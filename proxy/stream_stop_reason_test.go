package proxy

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestParseEventStreamToolUseStopWithoutToolIsTruncated(t *testing.T) {
	//! Upstream Kiro-Go #159: a tool_use stop with no tool delivered must not become end_turn.
	for _, reason := range []string{"tool_use", "TOOL_USE", "tool_calls", "toolUse", " Tool-Use "} {
		t.Run(reason, func(t *testing.T) {
			for name, frames := range map[string][][]byte{
				"with text": {
					awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Let me run that."}),
					awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": reason}),
					meteringFrame(t),
				},
				"without output": {
					awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": reason}),
				},
			} {
				t.Run(name, func(t *testing.T) {
					err := parseFrames(t, &KiroStreamCallback{}, frames...)
					if !errors.Is(err, errUpstreamTruncatedResponse) || !isStreamIntegrityError(err) {
						t.Fatalf("expected a retryable truncation error, got %v", err)
					}
				})
			}
		})
	}
}

func TestParseEventStreamToolUseStopWithToolCompletes(t *testing.T) {
	var toolUses []KiroToolUse
	err := parseFrames(t, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { toolUses = append(toolUses, tu) }},
		awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_1", "name": "read", "input": `{"path":"a"}`, "stop": true}),
		awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "tool_use"}),
	)
	if err != nil || len(toolUses) != 1 {
		t.Fatalf("err=%v tools=%#v, want one tool and no error", err, toolUses)
	}
}

func TestParseEventStreamExplicitStopWithoutOutputCompletes(t *testing.T) {
	for _, reason := range []string{"refusal", "content_filter", "CONTENT_FILTERED", "guardrail_intervened", "max_tokens", "model_context_window_exceeded"} {
		t.Run(reason, func(t *testing.T) {
			var got string
			err := parseFrames(t, &KiroStreamCallback{OnStopReason: func(r string) { got = r }},
				awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": reason}),
				meteringFrame(t),
			)
			if err != nil {
				t.Fatalf("an explicit %q stop must reach the client, got %v", reason, err)
			}
			if got != reason {
				t.Fatalf("stop reason = %q, want %q", got, reason)
			}
		})
	}
}

func TestParseEventStreamEndTurnWithoutOutputStaysEmpty(t *testing.T) {
	for _, reason := range []string{"end_turn", "END_TURN", "stop", "something_new"} {
		t.Run(reason, func(t *testing.T) {
			err := parseFrames(t, &KiroStreamCallback{},
				awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": reason}),
				meteringFrame(t),
			)
			if !errors.Is(err, errEmptyKiroStream) {
				t.Fatalf("expected empty stream error, got %v", err)
			}
		})
	}
}

func TestClaudeStreamRetriesToolUseStopWithoutTool(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writeFrames(w, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "TOOL_USE"}), meteringFrame(t))
			return
		}
		writeFrames(w,
			awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_1", "name": "read", "input": `{"path":"a"}`, "stop": true}),
			awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "tool_use"}),
		)
	})

	rec := httptest.NewRecorder()
	h.handleClaudeStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	body := rec.Body.String()
	if calls.Load() != 2 {
		t.Fatalf("expected the empty tool_use turn to be retried, got %d calls", calls.Load())
	}
	if !strings.Contains(body, `"stop_reason":"tool_use"`) || strings.Contains(body, `"stop_reason":"end_turn"`) {
		t.Fatalf("expected a tool_use stop from the retry, body=%s", body)
	}
}

func TestClaudeStreamReportsRefusalWithoutOutput(t *testing.T) {
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeFrames(w, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "content_filtered"}), meteringFrame(t))
	})

	rec := httptest.NewRecorder()
	h.handleClaudeStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)

	body := rec.Body.String()
	if calls.Load() != 1 {
		t.Fatalf("an explicit refusal is final, not an empty stream to retry; got %d calls", calls.Load())
	}
	if rec.Code != http.StatusOK || !strings.Contains(body, `"stop_reason":"refusal"`) || !strings.Contains(body, "event: message_stop") {
		t.Fatalf("expected a refusal stop, code=%d body=%s", rec.Code, body)
	}
}

func TestOpenAINonStreamReportsContentFilterWithoutOutput(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "guardrail_intervened"}))
	})

	rec := httptest.NewRecorder()
	h.handleOpenAINonStream(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"finish_reason":"content_filter"`) {
		t.Fatalf("expected content_filter finish, code=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInferMaxTokensStop(t *testing.T) {
	cases := []struct {
		reason      string
		output, max int
		wantReason  string
		description string
	}{
		{"", 100, 100, "max_tokens", "output reached the cap"},
		{"", 120, 100, "max_tokens", "estimate overshot the cap"},
		{"", 99, 100, "", "below the cap"},
		{"", 5000, 0, "", "no cap requested"},
		{"end_turn", 100, 100, "end_turn", "explicit stop wins"},
		{" ", 100, 100, "max_tokens", "blank counts as absent"},
	}
	for _, tc := range cases {
		if got := inferMaxTokensStop(tc.reason, tc.output, tc.max); strings.TrimSpace(got) != tc.wantReason {
			t.Errorf("%s: inferMaxTokensStop(%q, %d, %d) = %q, want %q", tc.description, tc.reason, tc.output, tc.max, got, tc.wantReason)
		}
	}
}

func cappedKiroPayload(maxTokens int) *KiroPayload {
	payload := testKiroPayload()
	payload.InferenceConfig = &InferenceConfig{MaxTokens: maxTokens}
	return payload
}

func cappedAnswerUpstream(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		//! IdC accounts never send metadataEvent: an answer cut at the cap ends with metering only.
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "This answer keeps going well past a tiny output budget and is cut"}),
			meteringFrame(t),
		)
	}
}

func TestMaxTokensInferredWithoutStopReason(t *testing.T) {
	t.Run("claude stream", func(t *testing.T) {
		h := newStreamTestHandler(t, cappedAnswerUpstream(t))
		rec := httptest.NewRecorder()
		h.handleClaudeStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), cappedKiroPayload(5), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
		if !strings.Contains(rec.Body.String(), `"stop_reason":"max_tokens"`) {
			t.Fatalf("expected max_tokens, body=%s", rec.Body.String())
		}
	})
	t.Run("claude non-stream uncapped", func(t *testing.T) {
		h := newStreamTestHandler(t, cappedAnswerUpstream(t))
		rec := httptest.NewRecorder()
		h.handleClaudeNonStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), cappedKiroPayload(100000), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
		if !strings.Contains(rec.Body.String(), `"stop_reason":"end_turn"`) {
			t.Fatalf("expected end_turn below the cap, body=%s", rec.Body.String())
		}
	})
	t.Run("claude non-stream", func(t *testing.T) {
		h := newStreamTestHandler(t, cappedAnswerUpstream(t))
		rec := httptest.NewRecorder()
		h.handleClaudeNonStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), cappedKiroPayload(5), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
		if !strings.Contains(rec.Body.String(), `"stop_reason":"max_tokens"`) {
			t.Fatalf("expected max_tokens, body=%s", rec.Body.String())
		}
	})
	t.Run("openai stream", func(t *testing.T) {
		h := newStreamTestHandler(t, cappedAnswerUpstream(t))
		rec := httptest.NewRecorder()
		h.handleOpenAIStream(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), cappedKiroPayload(5), "claude-sonnet-4.5", false, 1, nil)
		if !strings.Contains(rec.Body.String(), `"finish_reason":"length"`) {
			t.Fatalf("expected length, body=%s", rec.Body.String())
		}
	})
	t.Run("openai non-stream", func(t *testing.T) {
		h := newStreamTestHandler(t, cappedAnswerUpstream(t))
		rec := httptest.NewRecorder()
		h.handleOpenAINonStream(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), cappedKiroPayload(5), "claude-sonnet-4.5", false, 1, nil)
		if !strings.Contains(rec.Body.String(), `"finish_reason":"length"`) {
			t.Fatalf("expected length, body=%s", rec.Body.String())
		}
	})
	for _, stream := range []bool{false, true} {
		name := "responses non-stream"
		if stream {
			name = "responses stream"
		}
		t.Run(name, func(t *testing.T) {
			h := newResponsesTestHandler(t, cappedAnswerUpstream(t))
			reqBody, _ := json.Marshal(map[string]interface{}{"model": "claude-sonnet-4.5", "input": "hi", "stream": stream, "store": false, "max_output_tokens": 5})
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(string(reqBody))))
			body := rec.Body.String()
			if !strings.Contains(body, `"status":"incomplete"`) || !strings.Contains(body, `"reason":"max_output_tokens"`) {
				t.Fatalf("expected incomplete/max_output_tokens, body=%s", body)
			}
		})
	}
}

package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func setKeepaliveInterval(t *testing.T, d time.Duration) {
	t.Helper()
	old := sseKeepaliveInterval
	sseKeepaliveInterval = d
	t.Cleanup(func() { sseKeepaliveInterval = old })
}

func slowToolUpstream(t *testing.T, silence time.Duration) http.HandlerFunc {
	//! Text first, then silence, the way a long tool call or silent reasoning looks upstream.
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Writing the file now, this takes a while to finish."}))
		w.(http.Flusher).Flush()
		time.Sleep(silence)
		_, _ = w.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{"toolUseId": "toolu_1", "name": "write", "input": `{"path":"a"}`, "stop": true}))
		_, _ = w.Write(meteringFrame(t))
	}
}

func assertNoWritesAfterReturn(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	before := rec.Body.Len()
	time.Sleep(5 * sseKeepaliveInterval)
	if rec.Body.Len() != before {
		t.Fatalf("keepalive wrote after the handler returned")
	}
}

func TestClaudeStreamSendsPingWhileSilent(t *testing.T) {
	setKeepaliveInterval(t, 20*time.Millisecond)
	h := newStreamTestHandler(t, slowToolUpstream(t, 250*time.Millisecond))

	rec := httptest.NewRecorder()
	h.handleClaudeStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	assertNoWritesAfterReturn(t, rec)

	body := rec.Body.String()
	ping := strings.Index(body, "event: ping\ndata: {\"type\": \"ping\"}\n\n")
	if !strings.HasPrefix(body, "event: message_start\n") || ping < 0 {
		t.Fatalf("expected a ping after message_start, body=%s", body)
	}
	if stop := strings.Index(body, "event: message_stop"); stop < ping || !strings.Contains(body, `"stop_reason":"tool_use"`) {
		t.Fatalf("expected the turn to finish after the ping, body=%s", body)
	}
}

func TestOpenAIStreamSendsKeepaliveWhileSilent(t *testing.T) {
	setKeepaliveInterval(t, 20*time.Millisecond)
	h := newStreamTestHandler(t, slowToolUpstream(t, 250*time.Millisecond))

	rec := httptest.NewRecorder()
	h.handleOpenAIStream(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
	assertNoWritesAfterReturn(t, rec)

	body := rec.Body.String()
	if !strings.HasPrefix(body, "data: ") || !strings.Contains(body, "\n\n: keepalive\n\n") || !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("expected an SSE keepalive comment between chunks, body=%s", body)
	}
}

func TestResponsesStreamSendsKeepaliveWhileSilent(t *testing.T) {
	setKeepaliveInterval(t, 20*time.Millisecond)
	h := newResponsesTestHandler(t, slowToolUpstream(t, 250*time.Millisecond))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"hi","stream":true,"store":false,"tools":[{"type":"function","name":"write","parameters":{"type":"object"}}]}`)))
	assertNoWritesAfterReturn(t, rec)

	body := rec.Body.String()
	if !strings.HasPrefix(body, "event: response.created\n") || !strings.Contains(body, "\n\n: keepalive\n\n") || !strings.Contains(body, "event: response.completed") {
		t.Fatalf("expected an SSE keepalive comment between events, body=%s", body)
	}
	for _, block := range strings.Split(strings.TrimSpace(body), "\n\n") {
		if block != ": keepalive" && !strings.HasPrefix(block, "event: ") {
			t.Fatalf("keepalive split an event: %q", block)
		}
	}
}

func TestStreamsStayUncommittedUntilFirstOutput(t *testing.T) {
	setKeepaliveInterval(t, 20*time.Millisecond)
	t.Run("silent before output", func(t *testing.T) {
		h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
			_, _ = w.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "late answer"}))
			_, _ = w.Write(meteringFrame(t))
		})
		rec := httptest.NewRecorder()
		h.handleClaudeStream(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil), testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
		if body := rec.Body.String(); !strings.HasPrefix(body, "event: message_start\n") {
			t.Fatalf("nothing may precede message_start, body=%s", body)
		}
	})
	t.Run("slow failure keeps a real HTTP error", func(t *testing.T) {
		h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(150 * time.Millisecond)
			http.Error(w, `{"__type":"ThrottlingException","message":"Too many requests"}`, http.StatusTooManyRequests)
		})
		h.pool.RecordSuccess("only")
		t.Cleanup(func() { h.pool.RecordSuccess("only") })
		rec := httptest.NewRecorder()
		h.handleOpenAIStream(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil), testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
		assertNoWritesAfterReturn(t, rec)
		waitForCooldownSaved(t, "only")
		if rec.Code != http.StatusTooManyRequests || strings.Contains(rec.Body.String(), "keepalive") {
			t.Fatalf("expected a plain 429 error, code=%d body=%s", rec.Code, rec.Body.String())
		}
	})
}

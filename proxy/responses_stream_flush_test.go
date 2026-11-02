package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponsesStreamFlushesHeldTextBeforeFailure(t *testing.T) {
	//! The splitter holds a possible partial <thinking> tag; a failure must not swallow it.
	const answer = "The comparison holds when a <thi"
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": answer}))
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"claude-sonnet-4.5","input":"hi","stream":true,"store":false}`)))

	var text strings.Builder
	var failed bool
	for _, event := range parseResponsesSSE(t, rec.Body.String()) {
		switch event.Name {
		case "response.output_text.delta":
			delta, _ := event.Data["delta"].(string)
			text.WriteString(delta)
		case "response.failed":
			failed = true
		case "response.completed":
			t.Fatalf("a truncated stream must not complete, body=%s", rec.Body.String())
		}
	}
	if !failed {
		t.Fatalf("expected response.failed, body=%s", rec.Body.String())
	}
	if text.String() != answer {
		t.Fatalf("client text = %q, want full upstream text %q", text.String(), answer)
	}
}

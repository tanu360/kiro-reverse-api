package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

// threeKiroEndpoints points the three Kiro endpoints at one fake upstream, each on its own path.
func threeKiroEndpoints(t *testing.T, upstream http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	kiroEndpoints = []kiroEndpoint{
		{URL: server.URL + "/ide", Origin: "AI_EDITOR", Name: "Kiro IDE"},
		{URL: server.URL + "/cw", Origin: "AI_EDITOR", Name: "CodeWhisperer"},
		{URL: server.URL + "/q", Origin: "AI_EDITOR", Name: "AmazonQ"},
	}
	if err := config.UpdateEndpointFallback(true); err != nil {
		t.Fatal(err)
	}
}

// When every Kiro endpoint answers its own 429, each endpoint's attempt and log line carry
// that endpoint's error, not the first one's. The client's error may stay the merged one.
func TestEndpointAttemptsKeepTheirOwn429Text(t *testing.T) {
	bodies := map[string]string{
		"/ide": `{"message":"capacity one","reason":"INSUFFICIENT_MODEL_CAPACITY"}`,
		"/cw":  `{"message":"capacity two","reason":"INSUFFICIENT_MODEL_CAPACITY"}`,
		"/q":   `{"__type":"ThrottlingException","message":"slow down three"}`,
	}
	h := newAttemptChainHandler(t, 1, http.NotFound)
	threeKiroEndpoints(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, bodies[r.URL.Path], http.StatusTooManyRequests)
	})
	logs := captureLogs(t)

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429; body %s", rec.Code, rec.Body.String())
	}

	attempts := lastRecordedAttempts(t)
	if len(attempts) < 3 {
		t.Fatalf("attempts = %#v, want at least one per endpoint", attempts)
	}
	want := []struct{ endpoint, text string }{
		{"Kiro IDE", "HTTP 429 from Kiro IDE: " + bodies["/ide"]},
		{"CodeWhisperer", "HTTP 429 from CodeWhisperer: " + bodies["/cw"]},
		{"AmazonQ", "HTTP 429 from AmazonQ: " + bodies["/q"]},
	}
	for i, w := range want {
		a := attempts[i]
		if a.Endpoint != w.endpoint || a.Success || a.Status != http.StatusTooManyRequests {
			t.Fatalf("attempt %d = %#v, want a failed 429 on %s", i, a, w.endpoint)
		}
		if strings.TrimSpace(a.Message) != w.text {
			t.Errorf("attempt %d (%s) message = %q, want %q", i, w.endpoint, a.Message, w.text)
		}
	}

	out := logs.String()
	for _, w := range want[1:] {
		line := "Endpoint " + w.endpoint + " error: " + w.text
		if !strings.Contains(out, line) {
			t.Errorf("log lacks %q:\n%s", line, out)
		}
	}
	if strings.Contains(out, "Endpoint CodeWhisperer error: HTTP 429 from Kiro IDE") ||
		strings.Contains(out, "Endpoint AmazonQ error: HTTP 429 from Kiro IDE") {
		t.Errorf("a later endpoint logged the first endpoint's error:\n%s", out)
	}
}

// The last endpoint's attempt shows its own failure even when the request ends on an
// earlier endpoint's error (a 429 outranks a later 500 or 400).
func TestLastEndpointAttemptKeepsItsOwnErrorUnderAnEarlier429(t *testing.T) {
	h := newAttemptChainHandler(t, 1, http.NotFound)
	threeKiroEndpoints(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ide":
			http.Error(w, `{"message":"capacity one","reason":"INSUFFICIENT_MODEL_CAPACITY"}`, http.StatusTooManyRequests)
		case "/cw":
			http.Error(w, `{"message":"boom two"}`, http.StatusInternalServerError)
		default:
			http.Error(w, `{"message":"bad three"}`, http.StatusBadRequest)
		}
	})

	rec := httptest.NewRecorder()
	req := withRequestTrace(httptest.NewRequest(http.MethodPost, "/v1/messages", nil), requestEndpointClaude)
	h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want the 429 to win; body %s", rec.Code, rec.Body.String())
	}
	attempts := lastRecordedAttempts(t)
	if len(attempts) < 3 {
		t.Fatalf("attempts = %#v, want at least one per endpoint", attempts)
	}
	want := []struct {
		endpoint string
		status   int
		text     string
	}{
		{"Kiro IDE", 429, "HTTP 429 from Kiro IDE:"},
		{"CodeWhisperer", 500, "HTTP 500 from CodeWhisperer:"},
		{"AmazonQ", 400, "HTTP 400 from AmazonQ:"},
	}
	for i, w := range want {
		a := attempts[i]
		if a.Endpoint != w.endpoint || a.Status != w.status || !strings.HasPrefix(a.Message, w.text) {
			t.Errorf("attempt %d = %+v, want status %d and text starting %q", i, a, w.status, w.text)
		}
	}
}

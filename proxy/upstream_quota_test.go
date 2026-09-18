package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRetryAfterParsing(t *testing.T) {
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	for value, want := range map[string]time.Duration{"120": 2 * time.Minute, "-1": 0, "bad": 0, "0": 0, "999999999999": time.Hour, now.Add(30 * time.Second).Format(http.TimeFormat): 30 * time.Second, now.Add(-time.Minute).Format(http.TimeFormat): 0} {
		if got := retryAfterDuration(value, now); got != want {
			t.Fatalf("%q = %v want %v", value, got, want)
		}
	}
}

func TestUpstreamQuotaPreservesStatusHintAndCooldown(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "120")
				http.Error(w, "rate limited", 429)
			})
			t.Cleanup(func() { h.pool.RecordSuccess("only") })
			body := `{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`
			if path == "/v1/responses" {
				body = `{"model":"claude-sonnet-4.5","input":"hi"}`
			}
			rec := httptest.NewRecorder()
			r := httptest.NewRequest("POST", path, strings.NewReader(body))
			switch path {
			case "/v1/messages":
				h.handleClaudeMessages(rec, r)
			case "/v1/responses":
				h.handleOpenAIResponses(rec, r)
			default:
				h.handleOpenAIChat(rec, r)
			}
			if rec.Code != 429 || rec.Header().Get("Retry-After") != "120" {
				t.Fatalf("status/hint %d %s: %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
			}
			if h.pool.GetNext() != nil {
				t.Fatal("quota cooldown bypassed on next request")
			}
		})
	}
}

package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func shouldRetryOf(rec *httptest.ResponseRecorder) string {
	return rec.Header().Get("x-should-retry")
}

// Claude Code retried a wrong key 10 times over about 3 minutes, and a used-up call
// limit the same way. The header makes it show the error after one request.
func TestPermanentClientErrorsSayDoNotRetry(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-no-retry-0123456789", CallLimit: 1})
	requireKeys(t)

	cases := []struct {
		name, method, path, key, body string
		status                        int
	}{
		{"wrong key messages", http.MethodPost, "/v1/messages", "sk-wrong-key-for-test-0000", boundKeyClaudeBody, http.StatusUnauthorized},
		{"wrong key chat", http.MethodPost, "/v1/chat/completions", "sk-wrong-key-for-test-0000", boundKeyOpenAIBody, http.StatusUnauthorized},
		{"wrong key responses", http.MethodPost, "/v1/responses", "sk-wrong-key-for-test-0000", `{"model":"claude-sonnet-4.5","input":"hi"}`, http.StatusUnauthorized},
		{"wrong key count_tokens", http.MethodPost, "/v1/messages/count_tokens", "sk-wrong-key-for-test-0000", boundKeyClaudeBody, http.StatusUnauthorized},
		{"wrong key models", http.MethodGet, "/v1/models", "sk-wrong-key-for-test-0000", "", http.StatusUnauthorized},
		{"no key", http.MethodPost, "/v1/messages", "", boundKeyClaudeBody, http.StatusUnauthorized},
		{"invalid json", http.MethodPost, "/v1/messages", key.Key, `{`, http.StatusBadRequest},
		{"bad shape", http.MethodPost, "/v1/messages", key.Key, `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[]}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveWithKey(h, tc.method, tc.path, tc.key, tc.body)
			if rec.Code != tc.status || shouldRetryOf(rec) != "false" {
				t.Fatalf("status=%d x-should-retry=%q body=%s, want %d and false", rec.Code, shouldRetryOf(rec), rec.Body.String(), tc.status)
			}
		})
	}

	// The one call the key has, then the used-up limit, in both API shapes.
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody); rec.Code != http.StatusOK || shouldRetryOf(rec) != "" {
		t.Fatalf("first call: status=%d x-should-retry=%q", rec.Code, shouldRetryOf(rec))
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", boundKeyClaudeBody},
		{"/v1/chat/completions", boundKeyOpenAIBody},
		{"/v1/models", ""},
	} {
		method := http.MethodPost
		if tc.body == "" {
			method = http.MethodGet
		}
		rec := serveWithKey(h, method, tc.path, key.Key, tc.body)
		if rec.Code != http.StatusTooManyRequests || shouldRetryOf(rec) != "false" {
			t.Fatalf("%s over the call limit: status=%d x-should-retry=%q body=%s", tc.path, rec.Code, shouldRetryOf(rec), rec.Body.String())
		}
	}
	if calls := len(served.list()); calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", calls)
	}
}

// A call limit filled only by a call still in progress may clear when that call fails,
// so the client may retry it.
func TestCallLimitHeldByCallInProgressStaysRetryable(t *testing.T) {
	h := newKeyAccessHandler(t, recordingUpstream(t, &servedBy{}), "free-a")
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-in-progress-0123456789", CallLimit: 1})
	requireKeys(t)
	if _, err := config.ReserveApiKeyRequestUsage(key.ID, 1); err != nil {
		t.Fatalf("hold the only slot: %v", err)
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", key.Key, boundKeyClaudeBody)
	if _, message := errorMessageOf(t, rec); rec.Code != http.StatusTooManyRequests || !strings.Contains(message, "in progress") || shouldRetryOf(rec) != "" {
		t.Fatalf("status=%d message=%q x-should-retry=%q", rec.Code, message, shouldRetryOf(rec))
	}
}

func TestNoRetryStatusKeepsTransientStatusesRetryable(t *testing.T) {
	for _, status := range []int{http.StatusRequestTimeout, http.StatusConflict, http.StatusTooManyRequests, 499, 500, 502, 503, 504} {
		if noRetryStatus(status) {
			t.Fatalf("status %d marked as final", status)
		}
	}
	h := &Handler{}
	notServed := httptest.NewRecorder()
	h.sendClaudeError(notServed, http.StatusNotFound, "not_found_error", `model "claude-opus-5.5" is not available on any account`)
	if shouldRetryOf(notServed) != "false" {
		t.Fatalf("a model no account serves carries x-should-retry=%q", shouldRetryOf(notServed))
	}
	rec := httptest.NewRecorder()
	h.sendClaudeError(rec, http.StatusServiceUnavailable, "api_error", "No available accounts")
	h.sendOpenAIError(rec, http.StatusTooManyRequests, "rate_limit_error", "All accounts reached the limit")
	if shouldRetryOf(rec) != "" {
		t.Fatalf("transient error carries x-should-retry=%q", shouldRetryOf(rec))
	}
}

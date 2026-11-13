package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
)

// The "no account took this request" answer for a bound key looks only at the
// key's own accounts: other accounts' RPM limit or models never change it.

func TestBoundKeyCoolingDownGets503NotOtherAccountsRPMLimit(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "free-b")
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	unbound := addTestKey(t, config.ApiKeyEntry{Key: "sk-unbound"})
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound", AccountIDs: []string{"free-b"}})
	requireKeys(t)
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	// free-b cools down; free-a takes its one request of the minute.
	h.pool.RecordThrottleError("free-b", 5*time.Minute)
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", unbound.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("unbound key: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ path, body string }{
		{"/v1/messages", boundKeyClaudeBody},
		{"/v1/chat/completions", boundKeyOpenAIBody},
	} {
		rec := serveWithKey(h, http.MethodPost, tc.path, bound.Key, tc.body)
		if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "per minute") {
			t.Fatalf("%s: bound key whose only account cools down = %d %s, want 503 No available accounts", tc.path, rec.Code, rec.Body.String())
		}
		//! The cooldown end is known: the 503 says when free-b is back.
		if secs, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || secs < 290 || secs > 300 {
			t.Fatalf("%s: Retry-After = %q, want about 300", tc.path, rec.Header().Get("Retry-After"))
		}
	}
	// The unbound key may use free-a, which only the limit holds back: 429.
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", unbound.Key, boundKeyClaudeBody)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("unbound key with free-a at the limit: %d %s, want 429", rec.Code, rec.Body.String())
	}
}

func TestBoundKeyAtItsOwnRPMLimitGets429(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "free-b")
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound", AccountIDs: []string{"free-b"}})
	requireKeys(t)
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	if rec := serveWithKey(h, http.MethodPost, "/v1/messages", bound.Key, boundKeyClaudeBody); rec.Code != http.StatusOK {
		t.Fatalf("first bound request: %d %s", rec.Code, rec.Body.String())
	}
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", bound.Key, boundKeyClaudeBody)
	if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "rate_limit_error") {
		t.Fatalf("second bound request with free-b at the limit = %d %s, want 429 rate_limit_error", rec.Code, rec.Body.String())
	}
	if got := served.list(); len(got) != 1 || got[0] != "token-free-b" {
		t.Fatalf("served %v, want one request on free-b", got)
	}
}

func TestBoundKeyWithDisabledAccountGets503Not404(t *testing.T) {
	h := newKeyAccessHandler(t, recordingUpstream(t, &servedBy{}), "free-a", "off-b")
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound", AccountIDs: []string{"off-b"}})
	requireKeys(t)
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", bound.Key, boundKeyClaudeBody)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("bound key whose only account is disabled = %d %s, want 503", rec.Code, rec.Body.String())
	}
}

func TestBoundKeyModelOnlyOnOtherAccountsGets404(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a", "free-b")
	h.pool.SetModelList("free-a", []string{"claude-sonnet-4.5"})
	h.pool.SetModelList("free-b", []string{"claude-haiku-4.5"})
	bound := addTestKey(t, config.ApiKeyEntry{Key: "sk-bound", AccountIDs: []string{"free-b"}})
	requireKeys(t)
	rec := serveWithKey(h, http.MethodPost, "/v1/messages", bound.Key, boundKeyClaudeBody)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "not_found_error") {
		t.Fatalf("bound key asking for a model only free-a serves = %d %s, want 404 not_found_error", rec.Code, rec.Body.String())
	}
	rec = serveWithKey(h, http.MethodPost, "/v1/chat/completions", bound.Key, boundKeyOpenAIBody)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("OpenAI path: %d %s, want 404", rec.Code, rec.Body.String())
	}
	if got := served.list(); len(got) != 0 {
		t.Fatalf("served %v, want no upstream call", got)
	}
}

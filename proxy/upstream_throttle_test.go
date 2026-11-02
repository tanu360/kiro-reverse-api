package proxy

import (
	"errors"
	"kiro-proxy/db"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func waitForCooldownSaved(t *testing.T, id string) {
	//! The pool persists cooldowns asynchronously; a save racing TempDir cleanup recreates files.
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if d, err := db.Get(); err == nil {
			var n int
			if d.QueryRow(`SELECT COUNT(*) FROM cooldowns WHERE account_id = ?`, id).Scan(&n) == nil && n > 0 {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("cooldown for %s was never persisted", id)
}

func TestUsageQuotaExhaustedClassifier(t *testing.T) {
	exhausted := []string{
		`{"message":"You have reached the limit for this month.","reason":"MONTHLY_REQUEST_COUNT"}`,
		`HTTP 429: monthly quota reached`,
		`HTTP 429: quota exhausted`,
		`You've reached your usage limit. Upgrade to continue.`,
	}
	transient := []string{
		`{"__type":"com.amazon.aws.codewhisperer#ThrottlingException","message":"Too many requests, please wait before trying again."}`,
		`{"message":"I am experiencing high traffic, please try again shortly.","reason":"INSUFFICIENT_MODEL_CAPACITY"}`,
		`rate limited`,
		``,
	}
	for _, msg := range exhausted {
		if !isUsageQuotaExhaustedMessage(msg) {
			t.Errorf("expected %q to read as real quota exhaustion", msg)
		}
	}
	for _, msg := range transient {
		if isUsageQuotaExhaustedMessage(msg) {
			t.Errorf("expected %q to read as transient throttling", msg)
		}
	}
}

func TestQuotaMessageNeedsStandalone429(t *testing.T) {
	if isQuotaErrorMessage("HTTP 500: internal error, request id 74291abc") {
		t.Fatal("a 429 inside a request id is not a rate limit")
	}
	if !isQuotaErrorMessage("HTTP 429 from Kiro IDE: Too many requests") {
		t.Fatal("an HTTP 429 must still classify as quota/throttle")
	}
	if !isQuotaErrorMessage(`HTTP 402 from Kiro IDE: {"reason":"MONTHLY_REQUEST_COUNT"}`) {
		t.Fatal("monthly request exhaustion must classify as quota")
	}
}

func TestUpstream429CooldownDependsOnBody(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		min, max time.Duration
	}{
		{"throttling", `{"__type":"ThrottlingException","message":"Too many requests"}`, 30 * time.Second, 2 * time.Minute},
		{"capacity", `{"message":"high traffic","reason":"INSUFFICIENT_MODEL_CAPACITY"}`, 30 * time.Second, 2 * time.Minute},
		{"monthly quota", `{"message":"limit reached","reason":"MONTHLY_REQUEST_COUNT"}`, 20 * time.Hour, 1 << 62},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(tc.body))
			})
			//! The pool is a process singleton; start from a clean slate.
			h.pool.RecordSuccess("only")
			t.Cleanup(func() { h.pool.RecordSuccess("only") })

			rec := httptest.NewRecorder()
			h.handleClaudeMessages(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`)))
			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
			}
			waitForCooldownSaved(t, "only")
			if left := time.Until(h.pool.CooldownUntil("only")); left < tc.min || left > tc.max {
				t.Fatalf("cooldown = %v, want within [%v, %v]", left, tc.min, tc.max)
			}
		})
	}
}

func TestMessageOnlyThrottleGetsShortCooldown(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {})
	h.pool.RecordSuccess("only")
	t.Cleanup(func() { h.pool.RecordSuccess("only") })

	h.handleAccountFailure(testAccount(t), errors.New("token refresh failed: HTTP 429: Too many requests"))
	waitForCooldownSaved(t, "only")
	if left := time.Until(h.pool.CooldownUntil("only")); left <= 0 || left > 2*time.Minute {
		t.Fatalf("a throttled refresh must cool the account briefly, got %v", left)
	}
}

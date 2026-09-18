package proxy

import (
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUpstreamBadRequestDoesNotRetryOrCoolAccount(t *testing.T) {
	calls := 0
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) { calls++; http.Error(w, "Improperly formed request", 400) })
	h.pool.RecordSuccess("only")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}]}`)))
	if h.pool.GetNext() == nil {
		t.Fatal("healthy account was cooled")
	}
	if calls != 1 {
		t.Fatalf("calls=%d", calls)
	}
	if rec.Code != 400 {
		t.Fatalf("status=%d", rec.Code)
	}
}
func TestAdminRefreshAuthRetryPreservesEnabledState(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected inference") })
	acc := testAccount(t)
	acc.ID = "recovery"
	acc.AuthMethod = "idc"
	acc.RefreshToken = "refresh"
	acc.ClientID = "client"
	acc.ClientSecret = "secret"
	if err := config.AddAccount(*acc); err != nil {
		t.Fatal(err)
	}
	calls := 0
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return jsonResponse(403, `{}`), nil
		}
		return jsonResponse(200, `{}`), nil
	})
	old := auth.SetGlobalAuthClientForTest(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(200, `{"accessToken":"fresh","refreshToken":"fresh-refresh","expiresIn":3600}`), nil
	})})
	defer auth.SetGlobalAuthClientForTest(old)
	rec := httptest.NewRecorder()
	h.apiRefreshAccount(rec, httptest.NewRequest("POST", "/", nil), acc.ID)
	latest := storedAccount(acc.ID)
	if rec.Code != 200 || !latest.Enabled || latest.BanStatus == "BANNED" {
		t.Fatalf("status=%d enabled=%v ban=%s body=%s", rec.Code, latest.Enabled, latest.BanStatus, rec.Body.String())
	}
	if h.pool.GetNext() == nil {
		t.Fatal("recovered account unavailable")
	}
}
func TestAdminRefreshSuspensionReloadsPool(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected inference") })
	h.pool.RecordSuccess("only")
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		return jsonResponse(403, `{"message":"TEMPORARILY_SUSPENDED"}`), nil
	})
	rec := httptest.NewRecorder()
	h.apiRefreshAccount(rec, httptest.NewRequest("POST", "/", nil), "only")
	if storedAccount("only").Enabled || h.pool.GetNext() != nil {
		t.Fatal("disabled account remained selectable")
	}
}
func TestRestorePreservesEnvironmentPassword(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "env-password")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateSettingsPatch(nil, "backup-password"); err != nil {
		t.Fatal(err)
	}
	backup, err := config.CreateBackup("manual", "")
	if err != nil {
		t.Fatal(err)
	}
	config.SetPassword("env-password")
	if err := config.RestoreBackup(backup.ID); err != nil {
		t.Fatal(err)
	}
	if config.GetPassword() != "env-password" {
		t.Fatal("environment override was lost")
	}
}
func TestCacheBreakdownMatchesCappedCreation(t *testing.T) {
	tracker := newPromptCacheTracker(time.Hour)
	tracker.entriesByAccount["a"] = map[[32]byte]promptCacheEntry{{1}: {ExpiresAt: time.Now().Add(time.Hour), TTL: time.Hour}}
	p := &promptCacheProfile{Model: "claude-sonnet-4.5", TotalInputTokens: 10000, Breakpoints: []promptCacheBreakpoint{{Fingerprint: [32]byte{1}, CumulativeTokens: 8000, TTL: time.Hour}, {Fingerprint: [32]byte{2}, CumulativeTokens: 10000, TTL: time.Hour}}}
	u := tracker.Compute("a", p)
	if u.CacheCreationInputTokens != u.CacheCreation5mInputTokens+u.CacheCreation1hInputTokens {
		t.Fatal("breakdown matched")
	}
	t.Logf("creation=%d breakdown=%d", u.CacheCreationInputTokens, u.CacheCreation5mInputTokens+u.CacheCreation1hInputTokens)
}

func TestRefreshDoesNotEnableManuallyDisabledAccount(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected inference") })
	account := testAccount(t)
	account.Enabled = false
	account.BanStatus = "DISABLED"
	if err := config.UpdateAccount(account.ID, *account); err != nil {
		t.Fatal(err)
	}
	stubRestTransport(t, func(*http.Request) (*http.Response, error) { return jsonResponse(200, `{}`), nil })
	rec := httptest.NewRecorder()
	h.apiRefreshAccount(rec, httptest.NewRequest("POST", "/", nil), account.ID)
	if rec.Code != 200 || storedAccount(account.ID).Enabled {
		t.Fatalf("manual disable changed: status=%d", rec.Code)
	}
}

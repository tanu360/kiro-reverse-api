package proxy

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
)

const lockedAccountBody = `{"message":"Your account is suspended. We have locked your account because of unusual activity.","reason":"FORBIDDEN"}`

func TestSuspensionClassifierMatchesLockedAccount(t *testing.T) {
	locked := []string{
		"HTTP 403 from Kiro IDE: " + lockedAccountBody,
		"We've LOCKED YOUR ACCOUNT to keep it safe",
		"suspended: AWS locked your account",
	}
	for _, msg := range locked {
		if !isSuspensionErrorMessage(msg) {
			t.Errorf("isSuspensionErrorMessage(%q) = false, want true", msg)
		}
		if got := classifyRequestError(false, http.StatusForbidden, msg); got != "suspended" {
			t.Errorf("classifyRequestError(%q) = %q, want suspended", msg, got)
		}
	}
	for _, msg := range []string{"HTTP 403: forbidden", "the resource is locked", "unlock your account"} {
		if isSuspensionErrorMessage(msg) {
			t.Errorf("isSuspensionErrorMessage(%q) = true, want false", msg)
		}
	}
}

func setupHealTest(t *testing.T, accounts ...config.Account) *accountpool.AccountPool {
	t.Helper()
	dir := tempDataDir(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config init: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, acc := range accounts {
		if err := config.AddAccount(acc); err != nil {
			t.Fatalf("add account %s: %v", acc.ID, err)
		}
	}
	p := accountpool.GetPool()
	p.Reload()
	return p
}

func storedHealAccount(t *testing.T, id string) config.Account {
	t.Helper()
	for _, acc := range config.GetAccounts() {
		if acc.ID == id {
			return acc
		}
	}
	t.Fatalf("account %s not stored", id)
	return config.Account{}
}

func TestLockedAccount403BansAsSuspendedNotAuth(t *testing.T) {
	p := setupHealTest(t,
		config.Account{ID: "locked-req", Email: "req@example.com", Enabled: true, AccessToken: "token"},
		config.Account{ID: "locked-usage", Email: "usage@example.com", Enabled: true, AccessToken: "token", ProfileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"},
	)
	h := &Handler{pool: p}
	acc := storedHealAccount(t, "locked-req")
	h.handleAccountFailure(&acc, errors.New("HTTP 403 from Kiro IDE: "+lockedAccountBody))
	if got := storedHealAccount(t, "locked-req"); got.Enabled || got.BanStatus != "BANNED" || got.BanReason != banReasonSuspended {
		t.Fatalf("request path: enabled=%v ban=%q reason=%q, want a Kiro suspension", got.Enabled, got.BanStatus, got.BanReason)
	}

	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusForbidden, lockedAccountBody), nil
	})
	usageAcc := storedHealAccount(t, "locked-usage")
	if _, err := refreshAccountInfo(&usageAcc, true); err == nil || !strings.Contains(err.Error(), "account suspended") {
		t.Fatalf("usage check error = %v, want account suspended", err)
	}
	if got := storedHealAccount(t, "locked-usage"); got.BanReason != banReasonSuspended {
		t.Fatalf("usage path: reason=%q, want a Kiro suspension", got.BanReason)
	}
}

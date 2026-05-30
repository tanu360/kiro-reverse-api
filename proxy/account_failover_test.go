package proxy

import (
	"errors"
	"path/filepath"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
)

func TestAccountFailureClassifiers(t *testing.T) {
	tests := []struct {
		name string
		fn   func(string) bool
		msg  string
	}{
		{name: "quota", fn: isQuotaErrorMessage, msg: "HTTP 429: quota exhausted"},
		{name: "overage", fn: isOverageErrorMessage, msg: "HTTP 402 from Kiro IDE: OVERAGE limit exceeded"},
		{name: "suspension", fn: isSuspensionErrorMessage, msg: "Your User ID temporarily is suspended"},
		{name: "profile", fn: isProfileUnavailableErrorMessage, msg: "no available Kiro profile"},
		{name: "auth", fn: isAuthErrorMessage, msg: "Authentication failed - token invalid or expired"},
	}

	for _, tc := range tests {
		if !tc.fn(tc.msg) {
			t.Fatalf("%s classifier did not match %q", tc.name, tc.msg)
		}
	}
}

func TestProfileUnavailableFailureDoesNotDisableAccount(t *testing.T) {
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config init: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	account := config.Account{
		ID:      "acct-profile",
		Email:   "profile@example.com",
		Enabled: true,
	}
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("add account: %v", err)
	}

	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}
	h.handleAccountFailure(&account, errors.New("no available Kiro profile"))

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("expected one account, got %#v", accounts)
	}
	if !accounts[0].Enabled {
		t.Fatalf("profile lookup failure should not disable account: %#v", accounts[0])
	}
	if accounts[0].BanStatus != "" || accounts[0].BanReason != "" {
		t.Fatalf("profile lookup failure should not mark ban status: %#v", accounts[0])
	}
}

func TestTransientProfileFetchErrorClassifier(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "empty list", err: errors.New("empty profile list"), want: false},
		{name: "http 400", err: errors.New("HTTP 400: bad request"), want: false},
		{name: "http 429", err: errors.New("HTTP 429: rate limited"), want: true},
		{name: "http 500", err: errors.New("HTTP 500: upstream"), want: true},
		{name: "network", err: errors.New("dial tcp: i/o timeout"), want: true},
	}

	for _, tc := range tests {
		if got := isTransientProfileFetchError(tc.err); got != tc.want {
			t.Fatalf("%s: expected %v, got %v", tc.name, tc.want, got)
		}
	}
}

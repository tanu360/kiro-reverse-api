package proxy

import (
	"errors"
	"kiro-proxy/config"
	"testing"
)

// A background model listing must never be able to ban an account. Real traffic
// decides account health, because only it sees what a client actually got.
func TestBackgroundFailureIgnoresTransientErrors(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "acct", Email: "a@example.com", Enabled: true}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}
	h := newHandlerWithoutBackgroundForTest(t)
	account := &config.Account{ID: "acct", Email: "a@example.com", Enabled: true}

	for _, err := range []error{
		errors.New("dial tcp 10.0.0.1:443: connect: connection refused"),
		errors.New("HTTP 500 from test: internal error"),
		errors.New("unexpected EOF"),
	} {
		h.handleBackgroundAccountFailure(account, err)
	}

	for _, stored := range config.GetAccounts() {
		if stored.ID != "acct" {
			continue
		}
		if !stored.Enabled || stored.BanStatus != "" {
			t.Fatalf("transient background error disabled the account: enabled=%v ban=%q reason=%q",
				stored.Enabled, stored.BanStatus, stored.BanReason)
		}
	}
}

// A dead refresh token does prove the account cannot serve, so that one still counts.
func TestBackgroundFailureStillHandlesTerminalErrors(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "acct", Email: "a@example.com", Enabled: true}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}
	h := newHandlerWithoutBackgroundForTest(t)
	account := &config.Account{ID: "acct", Email: "a@example.com", Enabled: true}

	h.handleBackgroundAccountFailure(account, errors.New("token refresh failed: invalid_grant"))

	for _, stored := range config.GetAccounts() {
		if stored.ID != "acct" {
			continue
		}
		if stored.Enabled || stored.BanStatus != "BANNED" {
			t.Fatalf("dead credential left the account in rotation: enabled=%v ban=%q",
				stored.Enabled, stored.BanStatus)
		}
	}
}

func TestBackgroundFailureIgnoresNilInputs(t *testing.T) {
	h := &Handler{}
	h.handleBackgroundAccountFailure(nil, nil)
	h.handleBackgroundAccountFailure(nil, errors.New("invalid_grant"))
}

package proxy

import (
	"errors"
	"net/http"
	"testing"

	"kiro-proxy/config"
)

const banWriteProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"

// adminEditsAfterSnapshot is an admin's edit saved between a request or refresh taking its copy
// of the account and that copy's ban write.
func adminEditsAfterSnapshot(t *testing.T, id string, edit func(*config.Account)) {
	t.Helper()
	acc := storedHealAccount(t, id)
	edit(&acc)
	if err := config.UpdateAccount(id, acc); err != nil {
		t.Fatalf("admin edit: %v", err)
	}
}

func TestBanFromAnOldCopyKeepsTheAdminsLaterEdit(t *testing.T) {
	p := setupHealTest(t, config.Account{
		ID: "acc", Email: "a@example.com", Enabled: true, AccessToken: "token", ProfileArn: banWriteProfileArn,
		Nickname: "Main", Priority: 0, Weight: 5, ProxyURL: "http://127.0.0.1:9",
	})
	h := &Handler{pool: p}
	snapshot := storedHealAccount(t, "acc")
	adminEditsAfterSnapshot(t, "acc", func(acc *config.Account) {
		acc.Nickname, acc.Priority, acc.Weight, acc.ProxyURL = "Renamed", 7, 1, "http://127.0.0.1:19"
	})

	h.handleAccountFailure(&snapshot, errors.New("HTTP 403 from Kiro IDE: "+lockedAccountBody))

	got := storedHealAccount(t, "acc")
	if got.Enabled || got.BanStatus != "BANNED" || got.BanReason != banReasonSuspended {
		t.Fatalf("ban not written: enabled=%v ban=%q reason=%q", got.Enabled, got.BanStatus, got.BanReason)
	}
	if got.Nickname != "Renamed" || got.Priority != 7 || got.Weight != 1 || got.ProxyURL != "http://127.0.0.1:19" {
		t.Fatalf("the ban wrote the old copy over the admin's edit: %+v", got)
	}
}

func TestSweepAuthBanKeepsAnAdminSwitchOff(t *testing.T) {
	setupHealTest(t, config.Account{
		ID: "acc", Email: "a@example.com", Enabled: true, BanStatus: "ACTIVE", AccessToken: "token",
		ProfileArn: banWriteProfileArn, Priority: 2,
	})
	// The sweep took its copy while the account was on; the admin then switched it off.
	snapshot := storedHealAccount(t, "acc")
	adminEditsAfterSnapshot(t, "acc", func(acc *config.Account) {
		acc.Enabled = false
		acc.Priority = 9
	})
	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusUnauthorized, `{"message":"The bearer token included in the request is invalid."}`), nil
	})

	if _, err := refreshAccountInfo(&snapshot, true); err == nil {
		t.Fatal("usage check succeeded, want the 401")
	}

	got := storedHealAccount(t, "acc")
	if got.Enabled || got.BanStatus != "DISABLED" || got.BanReason != banReasonAuthFailed {
		t.Fatalf("enabled=%v ban=%q reason=%q, want the admin's DISABLED kept so self-heal leaves it off", got.Enabled, got.BanStatus, got.BanReason)
	}
	if got.Priority != 9 {
		t.Fatalf("the sweep wrote its old copy back: priority %d", got.Priority)
	}
	if healed, err := config.ReenableBannedAccounts([]string{"acc"}, banReasonAuthFailed); err != nil || len(healed) != 0 {
		t.Fatalf("self-heal switched the admin's account back on: %v %v", healed, err)
	}
}

func TestBanClearKeepsAnAdminSwitchOnMadeDuringTheRefresh(t *testing.T) {
	setupHealTest(t, config.Account{
		ID: "acc", Email: "a@example.com", Enabled: false, BanStatus: "BANNED", BanReason: banReasonAuthFailed,
		AccessToken: "token", ProfileArn: banWriteProfileArn,
	})
	// The admin pressed Refresh on the banned account, then switched it on before Kiro answered.
	snapshot := storedHealAccount(t, "acc")
	adminEditsAfterSnapshot(t, "acc", func(acc *config.Account) {
		acc.Enabled = true
		acc.Weight = 3
	})
	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{"userInfo":{"email":"a@example.com","userId":"u-1"}}`), nil
	})

	if _, err := refreshAccountInfo(&snapshot, false); err != nil {
		t.Fatalf("usage check: %v", err)
	}

	got := storedHealAccount(t, "acc")
	if !got.Enabled || got.Weight != 3 {
		t.Fatalf("the ban clear wrote the old copy back: enabled=%v weight=%d", got.Enabled, got.Weight)
	}
	if got.BanStatus != "ACTIVE" || got.BanReason != "" || got.BanTime != 0 {
		t.Fatalf("ban not cleared: %q %q %d", got.BanStatus, got.BanReason, got.BanTime)
	}
}

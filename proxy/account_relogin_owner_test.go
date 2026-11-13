package proxy

import (
	"net/http"
	"testing"
	"time"

	"kiro-proxy/config"
)

// otherReloginAccount is a second stored user: Y in "re-login X with Y's credentials".
func otherReloginAccount(id string) config.Account {
	account := baseReloginAccount(id)
	account.Email = "other@example.com"
	account.UserId = "user-2"
	account.Nickname = "Other"
	account.AccessToken = "at-y"
	account.RefreshToken = "rt-y"
	account.RequestCount = 7
	return account
}

func pendingCount() int {
	reloginPending.mu.Lock()
	defer reloginPending.mu.Unlock()
	return len(reloginPending.entries)
}

func TestReloginWithAnotherAccountsTokenRefusedBeforeRefresh(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	addReloginTarget(t, otherReloginAccount("acc-2"))

	body := idcCredentials("acc-1")
	body["refreshToken"] = " rt-y "
	rec, decoded := callRelogin(t, h.apiImportCredentials, body)
	if rec.Code != http.StatusConflict || decoded["code"] != codeReloginOtherAccount {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if decoded["otherAccountId"] != "acc-2" || decoded["otherEmail"] != "other@example.com" || decoded["saved"] != false || decoded["accountId"] != "acc-1" {
		t.Fatalf("body = %v", decoded)
	}
	if hits := fake.hitCount(); hits != 0 {
		t.Fatalf("the pasted token was sent upstream %d times; a refresh would rotate it", hits)
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.RefreshToken != "rt-old" {
		t.Fatalf("target changed: %+v", got)
	}
	if got := storedRelogin(t, "acc-2"); got.AccessToken != "at-y" || got.RefreshToken != "rt-y" {
		t.Fatalf("owner changed: %+v", got)
	}
	if n := pendingCount(); n != 0 {
		t.Fatalf("%d logins stashed", n)
	}
}

func TestReloginAsAnotherAccountsUserSavesIntoThatAccount(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	owner := otherReloginAccount("acc-2")
	owner.Enabled = false
	owner.BanStatus = "BANNED"
	owner.BanReason = config.AuthFailureBanReason
	owner.BanTime = time.Now().Unix()
	addReloginTarget(t, owner)
	// The pasted token is not the stored one (an older export); its refresh rotates it.
	fake.access, fake.refresh = "at-y-new", "rt-y-rotated"
	fake.users["at-y-new"] = [2]string{"other@example.com", "user-2"}

	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusConflict || body["code"] != codeReloginOtherAccount || body["saved"] != true || body["otherAccountId"] != "acc-2" {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if n := pendingCount(); n != 0 {
		t.Fatalf("%d logins stashed; another account's login must never wait for a confirm", n)
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.RefreshToken != "rt-old" || got.Email != "dev@example.com" {
		t.Fatalf("target changed: %+v", got)
	}
	got := storedRelogin(t, "acc-2")
	if got.AccessToken != "at-y-new" || got.RefreshToken != "rt-y-rotated" {
		t.Fatalf("the rotated tokens did not reach their account: %+v", got)
	}
	if got.Nickname != "Other" || got.RequestCount != 7 || got.MachineId != "machine-keep" {
		t.Fatalf("owner's settings changed: %+v", got)
	}
	if !got.Enabled || got.BanStatus != "ACTIVE" {
		t.Fatalf("a fresh login did not lift the auth ban: %+v", got)
	}
	if n := len(config.GetAccounts()); n != 2 {
		t.Fatalf("accounts = %d, want 2", n)
	}
}

func TestReloginUnverifiedTargetRefusesAnotherAccountsUser(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	target := baseReloginAccount("acc-1")
	target.Email, target.UserId = "", ""
	addReloginTarget(t, target)
	addReloginTarget(t, otherReloginAccount("acc-2"))
	fake.access, fake.refresh = "at-y-new", "rt-y-new"
	fake.users["at-y-new"] = [2]string{"other@example.com", "user-2"}

	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusConflict || body["code"] != codeReloginOtherAccount {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" {
		t.Fatalf("an unverified target took another account's login: %+v", got)
	}
}

func TestReloginConfirmRefusesALoginThatIsNowAnotherAccount(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-y-new", "rt-y-new"
	fake.users["at-y-new"] = [2]string{"other@example.com", "user-2"}

	_, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	pendingID, _ := body["pendingId"].(string)
	if body["code"] != codeReloginIdentityMismatch || pendingID == "" {
		t.Fatalf("setup: %v", body)
	}
	// The same user is added as its own account while the confirm waits.
	addReloginTarget(t, otherReloginAccount("acc-2"))

	rec, body := callPending(h, true, "acc-1", pendingID)
	if rec.Code != http.StatusConflict || body["code"] != codeReloginOtherAccount || body["otherAccountId"] != "acc-2" {
		t.Fatalf("confirm status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.UserId != "user-1" {
		t.Fatalf("confirm moved the target onto another account's user: %+v", got)
	}
}

func TestReloginKeepsAnAdminSwitchOffOfAnAuthBan(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	parked := baseReloginAccount("parked")
	parked.Enabled = false
	parked.BanStatus = "BANNED"
	parked.BanReason = banReasonAuthFailed
	parked.BanTime = time.Now().Unix()
	keepOffForAdmin(&parked)
	if parked.BanStatus != "DISABLED" {
		t.Fatalf("setup: %q", parked.BanStatus)
	}
	addReloginTarget(t, parked)
	fake.access, fake.refresh = "at-new", "rt-new"
	fake.users["at-new"] = [2]string{"dev@example.com", "user-1"}

	if rec, _ := callRelogin(t, h.apiImportCredentials, idcCredentials("parked")); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "parked")
	if got.Enabled || got.BanStatus != "DISABLED" {
		t.Fatalf("re-login switched a parked account back on: %+v", got)
	}
	if got.AccessToken != "at-new" {
		t.Fatalf("tokens not replaced: %+v", got)
	}
}

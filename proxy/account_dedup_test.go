package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/auth"
	"kiro-proxy/config"
	"kiro-proxy/db"
	accountpool "kiro-proxy/pool"
)

func newDedupHandler(t *testing.T, seed ...config.Account) *Handler {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, a := range seed {
		if err := config.AddAccount(a); err != nil {
			t.Fatalf("seed %s: %v", a.ID, err)
		}
	}
	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p}
}

// stubOIDCAndUserInfo answers the OIDC refresh and the usage call that names
// the user, with no network; email() is read on every usage call.
func stubOIDCAndUserInfo(t *testing.T, email func() string) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case r.Method == http.MethodPost && r.URL.Host == "oidc.test":
			return jsonResponse(http.StatusOK, fmt.Sprintf(`{"accessToken":"at-new","refreshToken":"rt-%s","expiresIn":3600}`, email())), nil
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "getUsageLimits"):
			return jsonResponse(http.StatusOK, fmt.Sprintf(`{"userInfo":{"email":%q,"userId":"u-%s"}}`, email(), email())), nil
		}
		return nil, fmt.Errorf("unexpected request in test: %s %s", r.Method, r.URL)
	})}
	previous := auth.SetGlobalAuthClientForTest(client)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previous) })
	oldOIDC := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return "https://oidc.test/token" })
	t.Cleanup(func() { auth.SetOIDCTokenURLForTest(oldOIDC) })
}

type savedAccountResponse struct {
	Success bool `json:"success"`
	Account struct {
		ID      string `json:"id"`
		Email   string `json:"email"`
		Updated bool   `json:"updated"`
	} `json:"account"`
}

func decodeSaved(t *testing.T, rec *httptest.ResponseRecorder) savedAccountResponse {
	t.Helper()
	var resp savedAccountResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return resp
}

func TestApiImportCredentialsUpdatesExistingAccount(t *testing.T) {
	h := newDedupHandler(t, config.Account{
		ID: "existing", Email: "dev@example.com", AuthMethod: "idc", Provider: "BuilderId",
		AccessToken: "at-old", RefreshToken: "rt-old", ClientID: "c", ClientSecret: "s", Region: "us-east-1",
		Enabled: true, Nickname: "primary", Weight: 2, RequestCount: 5,
	})
	email := "dev@example.com"
	stubOIDCAndUserInfo(t, func() string { return email })

	body := `{"refreshToken":"rt-import","clientId":"c","clientSecret":"s","authMethod":"idc","provider":"BuilderId","region":"us-east-1"}`
	rec := importCredentials(h, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeSaved(t, rec)
	if resp.Account.ID != "existing" || !resp.Account.Updated {
		t.Fatalf("import answered %+v, want the existing account updated", resp.Account)
	}
	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("accounts = %d, want 1", len(accounts))
	}
	got := accounts[0]
	if got.AccessToken != "at-new" || got.RefreshToken != "rt-dev@example.com" || got.UserId != "u-dev@example.com" {
		t.Fatalf("existing account did not take the new credential: %+v", got)
	}
	if got.Nickname != "primary" || got.Weight != 2 || got.RequestCount != 5 {
		t.Fatalf("operator fields or counters changed: %+v", got)
	}

	email = "other@example.com"
	rec = importCredentials(h, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("second import status = %d body=%s", rec.Code, rec.Body.String())
	}
	if resp := decodeSaved(t, rec); resp.Account.Updated || resp.Account.ID == "existing" {
		t.Fatalf("another user's import answered %+v, want a new account", resp.Account)
	}
	if n := len(config.GetAccounts()); n != 2 {
		t.Fatalf("accounts = %d, want 2", n)
	}
}

func TestMicrosoftReloginUpdatesExistingAccount(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	issuer := handlerMicrosoftIssuerURL()
	existing := config.Account{
		ID: "entra", Email: "me@contoso.com", UserId: issuer + ".object", AuthMethod: auth.MicrosoftSSOAuthMethod,
		Provider: auth.MicrosoftSSOProvider, AccessToken: "at-dead", RefreshToken: "rt-dead", ClientID: handlerMicrosoftClientID,
		IssuerURL: issuer, Region: "us-east-1", Enabled: true, Nickname: "team",
	}
	if err := config.AddAccount(existing); err != nil {
		t.Fatalf("seed: %v", err)
	}

	relogin := existing
	relogin.ID = "relogin"
	relogin.Nickname = ""
	relogin.AccessToken = "at-fresh"
	relogin.RefreshToken = "rt-fresh"
	relogin.ExpiresAt = time.Now().Add(time.Hour).Unix()
	microsoftSSOFlows.mu.Lock()
	stored, updated, err := microsoftSSOFlows.saveAccountLocked("relogin-session", relogin)
	microsoftSSOFlows.mu.Unlock()
	if err != nil || !updated || stored.ID != "entra" {
		t.Fatalf("relogin saved %+v updated=%v err=%v, want the stored account updated", stored, updated, err)
	}
	accounts := config.GetAccounts()
	if len(accounts) != 1 || accounts[0].RefreshToken != "rt-fresh" || accounts[0].Nickname != "team" {
		t.Fatalf("accounts after relogin = %+v", accounts)
	}

	rec := httptest.NewRecorder()
	h.writeMicrosoftSaved(rec, stored, microsoftWarning{}, updated)
	if resp := decodeSaved(t, rec); resp.Account.ID != "entra" || !resp.Account.Updated {
		t.Fatalf("relogin answered %+v", resp.Account)
	}
}

func TestMicrosoftReloginKeepsStoredProfileWithoutPendingWarning(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	pending := microsoftWarning{text: "The account was added, but its Kiro profile could not be resolved yet", code: codeMicrosoftProfilePending}
	warningOf := func(account config.Account, updated bool) string {
		rec := httptest.NewRecorder()
		h.writeMicrosoftSaved(rec, account, pending, updated)
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		code, _ := resp["warningCode"].(string)
		return code
	}
	resolved := config.Account{ID: "entra", Email: "me@contoso.com", ProfileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P"}
	if code := warningOf(resolved, true); code != "" {
		t.Fatalf("an update that kept the stored profile warned %q", code)
	}
	if code := warningOf(resolved, false); code != codeMicrosoftProfilePending {
		t.Fatalf("a new account warned %q, want %q", code, codeMicrosoftProfilePending)
	}
	unresolved := resolved
	unresolved.ProfileArn = ""
	if code := warningOf(unresolved, true); code != codeMicrosoftProfilePending {
		t.Fatalf("an update with no stored profile warned %q, want %q", code, codeMicrosoftProfilePending)
	}
}

func TestAuthFailureBanUsesTheReasonAnUpsertLifts(t *testing.T) {
	account := config.Account{ID: "dead", Email: "dead@example.com", AuthMethod: "idc", Provider: "BuilderId", UserId: "u-dead",
		RefreshToken: "rt-dead", Enabled: true}
	h := newDedupHandler(t, account)
	h.handleAccountFailure(&account, errors.New("HTTP 401: unauthorized"))
	banned := config.GetAccounts()[0]
	if banned.Enabled || !config.IsAuthFailureBan(&banned) {
		t.Fatalf("auth failure stored %q/%q, want the ban an upsert lifts", banned.BanStatus, banned.BanReason)
	}
	stored, updated, err := config.UpsertAccount(config.Account{ID: "relogin", AuthMethod: "idc", Provider: "BuilderId",
		UserId: "u-dead", AccessToken: "at-fresh", RefreshToken: "rt-fresh", Enabled: true})
	if err != nil || !updated || stored.ID != "dead" || !stored.Enabled || stored.BanStatus != "ACTIVE" {
		t.Fatalf("relogin saved %+v updated=%v err=%v, want the banned account revived", stored, updated, err)
	}
}

func TestApiListDuplicateAccountsHidesSecrets(t *testing.T) {
	h := newDedupHandler(t,
		config.Account{ID: "old", Email: "dev@example.com", AuthMethod: "social", Provider: "Google",
			AccessToken: "at-secret-1", RefreshToken: "rt-secret-shared", ClientSecret: "cs-secret", Enabled: true, LastRefresh: 100, RequestCount: 2},
		config.Account{ID: "lone", Email: "lone@example.com", AuthMethod: "social", Provider: "Google",
			RefreshToken: "rt-secret-lone", Enabled: true},
		config.Account{ID: "new", Email: "dev@example.com", AuthMethod: "social", Provider: "Google",
			AccessToken: "at-secret-2", RefreshToken: "rt-secret-shared", Enabled: true, LastRefresh: 200},
	)
	rec := httptest.NewRecorder()
	h.apiListDuplicateAccounts(rec, httptest.NewRequest(http.MethodGet, "/accounts/duplicates", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("duplicate list leaked a secret: %s", rec.Body.String())
	}
	var resp struct {
		DuplicateCount int `json:"duplicateCount"`
		Groups         []struct {
			Reasons         []string `json:"reasons"`
			SuggestedKeepID string   `json:"suggestedKeepId"`
			Accounts        []struct {
				ID           string `json:"id"`
				Healthy      bool   `json:"healthy"`
				RequestCount int    `json:"requestCount"`
			} `json:"accounts"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.DuplicateCount != 1 || len(resp.Groups) != 1 {
		t.Fatalf("response = %+v, want one group of two", resp)
	}
	group := resp.Groups[0]
	if group.SuggestedKeepID != "new" || len(group.Accounts) != 2 || group.Accounts[0].ID != "old" {
		t.Fatalf("group = %+v, want old and new with new suggested", group)
	}
	if strings.Join(group.Reasons, ",") != "refresh_token" {
		t.Fatalf("reasons = %v", group.Reasons)
	}
	if !group.Accounts[0].Healthy || group.Accounts[0].RequestCount != 2 {
		t.Fatalf("account view = %+v", group.Accounts[0])
	}
}

func postMerge(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.apiMergeDuplicateAccounts(rec, httptest.NewRequest(http.MethodPost, "/accounts/duplicates/merge", strings.NewReader(body)))
	return rec
}

func TestApiMergeDuplicateAccountsMovesHistoryAndSumsCounters(t *testing.T) {
	h := newDedupHandler(t,
		config.Account{ID: "keep", Email: "dev@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-k",
			ExpiresAt: 500, Enabled: true, RequestCount: 3, ErrorCount: 1, TotalTokens: 30, TotalCredits: 0.5, LastUsed: 10},
		config.Account{ID: "dup", Email: "DEV@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-d",
			ExpiresAt: 100, Enabled: true, RequestCount: 4, ErrorCount: 2, TotalTokens: 40, TotalCredits: 0.25, LastUsed: 20},
		config.Account{ID: "other", Email: "other@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-o", Enabled: true, RequestCount: 9},
	)
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	for _, id := range []string{"keep", "dup", "dup", "other"} {
		if _, err := d.Exec(`INSERT INTO requests(ts, account_id, email) VALUES(?, ?, ?)`, time.Now().Unix(), id, "dev@example.com"); err != nil {
			t.Fatalf("insert request: %v", err)
		}
	}
	if _, err := d.Exec(`INSERT INTO errors(ts, account_id) VALUES(?, ?)`, time.Now().Unix(), "dup"); err != nil {
		t.Fatalf("insert error row: %v", err)
	}

	rec := postMerge(h, `{"keepId":"keep","ids":["keep","dup"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("merge status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success       bool     `json:"success"`
		KeptID        string   `json:"keptId"`
		Removed       []string `json:"removed"`
		RequestsMoved int64    `json:"requestsMoved"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.Success || resp.KeptID != "keep" || len(resp.Removed) != 1 || resp.Removed[0] != "dup" || resp.RequestsMoved != 2 {
		t.Fatalf("merge answered %+v", resp)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 2 || accounts[0].ID != "keep" || accounts[1].ID != "other" {
		t.Fatalf("accounts after merge = %+v", accounts)
	}
	kept := accounts[0]
	if kept.RequestCount != 7 || kept.ErrorCount != 3 || kept.TotalTokens != 70 || kept.TotalCredits != 0.75 || kept.LastUsed != 20 {
		t.Fatalf("summed counters = %+v", kept)
	}
	if live := h.pool.GetByID("keep"); live == nil || live.RequestCount != 7 {
		t.Fatalf("pool was not reloaded with the summed counters: %+v", live)
	}

	var left, errorsLeft int
	if err := d.QueryRow(`SELECT COUNT(*) FROM requests WHERE account_id='dup'`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("requests still on the removed id: %d err=%v", left, err)
	}
	if err := d.QueryRow(`SELECT COUNT(*) FROM errors WHERE account_id='keep'`).Scan(&errorsLeft); err != nil || errorsLeft != 1 {
		t.Fatalf("error rows on the kept id: %d err=%v", errorsLeft, err)
	}
	var total int
	if err := d.QueryRow(`SELECT COUNT(*) FROM requests`).Scan(&total); err != nil || total != 4 {
		t.Fatalf("request rows = %d err=%v, want all 4 kept", total, err)
	}

	backups, err := config.ListBackups(true)
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	found := false
	for _, b := range backups {
		if b.Kind == "auto" && b.Note == "before merging duplicate accounts" && b.AccountCnt == 3 {
			found = true
		}
	}
	if !found {
		t.Fatalf("no pre-merge backup with the 3 accounts: %+v", backups)
	}
}

func TestApiMergeDuplicateAccountsRejectsChangedGroup(t *testing.T) {
	h := newDedupHandler(t,
		config.Account{ID: "a", Email: "dev@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-a", Enabled: true},
		config.Account{ID: "b", Email: "dev@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-b", Enabled: true},
		config.Account{ID: "c", Email: "c@example.com", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-c", Enabled: true},
	)
	for _, tc := range []struct {
		body   string
		status int
		code   string
	}{
		{`{"keepId":"a","ids":["a","c"]}`, http.StatusConflict, codeDuplicatesChanged},
		{`{"keepId":"a","ids":["a","gone"]}`, http.StatusConflict, codeDuplicatesChanged},
		{`{"keepId":"a","ids":["a"]}`, http.StatusBadRequest, codeNoAccountIDs},
		{`{"keepId":"","ids":["a","b"]}`, http.StatusBadRequest, codeNoAccountIDs},
		{`{"keepId":`, http.StatusBadRequest, codeInvalidJSON},
	} {
		rec := postMerge(h, tc.body)
		var resp map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if rec.Code != tc.status || resp["code"] != tc.code {
			t.Fatalf("%s: status %d code %q, want %d %q (body %s)", tc.body, rec.Code, resp["code"], tc.status, tc.code, rec.Body.String())
		}
	}
	if n := len(config.GetAccounts()); n != 3 {
		t.Fatalf("a refused merge removed accounts: %d left", n)
	}
	if backups, _ := config.ListBackups(true); len(backups) != 0 {
		t.Fatalf("a refused merge took a backup: %+v", backups)
	}
}

package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

// reloginFakeAWS answers every AWS auth call a re-login can make: OIDC client registration,
// device authorization, the token endpoint, and the getUsageLimits user lookup. Users are keyed
// by access token.
type reloginFakeAWS struct {
	mu       sync.Mutex
	hits     int
	users    map[string][2]string
	failInfo bool
	access   string
	refresh  string
	arn      string
}

func (f *reloginFakeAWS) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.hits++
	f.mu.Unlock()
	host, path := req.URL.Hostname(), req.URL.Path
	switch {
	case host == "q.us-east-1.amazonaws.com" && path == "/getUsageLimits":
		token := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		user, ok := f.users[token]
		if !ok || f.failInfo {
			return handlerMicrosoftJSONResponse(req, http.StatusInternalServerError, map[string]string{}), nil
		}
		return handlerMicrosoftJSONResponse(req, http.StatusOK, map[string]interface{}{
			"userInfo": map[string]string{"email": user[0], "userId": user[1]},
		}), nil
	case strings.HasPrefix(host, "oidc.") && path == "/client/register":
		return handlerMicrosoftJSONResponse(req, http.StatusOK, map[string]string{
			"clientId": "client-new", "clientSecret": "secret-new",
		}), nil
	case strings.HasPrefix(host, "oidc.") && path == "/device_authorization":
		return handlerMicrosoftJSONResponse(req, http.StatusOK, map[string]interface{}{
			"deviceCode": "device-code", "userCode": "ABCD-EFGH",
			"verificationUri": "https://view.awsapps.com/start/#/device", "interval": 1, "expiresIn": 600,
		}), nil
	case strings.HasPrefix(host, "oidc.") && path == "/token":
		return handlerMicrosoftJSONResponse(req, http.StatusOK, map[string]interface{}{
			"accessToken": f.access, "refreshToken": f.refresh, "expiresIn": 3600, "profileArn": f.arn,
		}), nil
	}
	return nil, fmt.Errorf("unexpected upstream request %s %s", req.Method, req.URL)
}

func (f *reloginFakeAWS) hitCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits
}

// newReloginHandler starts each test on an empty store, fresh relogin state, a fake AWS and a
// recorder in place of the background verify. Kiro REST calls fail the test.
func newReloginHandler(t *testing.T) (*Handler, *reloginFakeAWS, chan config.Account) {
	t.Helper()
	h := newMicrosoftHandlerForTest(t)

	prevSessions, prevPending := reloginSessions, reloginPending
	reloginSessions = &reloginBindings{targets: make(map[string]reloginBinding)}
	reloginPending = &reloginStash{entries: make(map[string]reloginPendingEntry)}
	t.Cleanup(func() { reloginSessions, reloginPending = prevSessions, prevPending })

	verified := make(chan config.Account, 8)
	prevVerify := reloginVerify
	reloginVerify = func(_ *Handler, account config.Account) { verified <- account }
	t.Cleanup(func() { reloginVerify = prevVerify })

	fake := &reloginFakeAWS{users: make(map[string][2]string)}
	prevClient := auth.SetGlobalAuthClientForTest(&http.Client{Timeout: 5 * time.Second, Transport: fake})
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(prevClient) })
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		fake.mu.Lock()
		fake.hits++
		fake.mu.Unlock()
		return nil, fmt.Errorf("Kiro REST disabled in test: %s", req.URL)
	})
	return h, fake, verified
}

func addReloginTarget(t *testing.T, account config.Account) {
	t.Helper()
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("add account: %v", err)
	}
}

func storedRelogin(t *testing.T, id string) config.Account {
	t.Helper()
	account := findAccountByID(id)
	if account == nil {
		t.Fatalf("account %s is gone", id)
	}
	return *account
}

func callRelogin(t *testing.T, handler func(http.ResponseWriter, *http.Request), body interface{}) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(raw))))
	var decoded map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
	return rec, decoded
}

func callPending(h *Handler, confirm bool, accountID, pendingID string) (*httptest.ResponseRecorder, map[string]interface{}) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"pendingId":%q}`, pendingID)))
	if confirm {
		h.apiConfirmRelogin(rec, req, accountID)
	} else {
		h.apiDiscardRelogin(rec, req, accountID)
	}
	var decoded map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
	return rec, decoded
}

func idcCredentials(targetID string) map[string]interface{} {
	return map[string]interface{}{
		"refreshToken": "rt-paste", "clientId": "client-x", "clientSecret": "secret-x",
		"authMethod": "idc", "region": "us-east-1", "reloginAccountId": targetID,
		"nickname": "ignored nickname",
	}
}

func baseReloginAccount(id string) config.Account {
	return config.Account{
		ID:           id,
		Email:        "dev@example.com",
		UserId:       "user-1",
		Nickname:     "Main",
		AccessToken:  "at-old",
		RefreshToken: "rt-old",
		ClientID:     "client-old",
		ClientSecret: "secret-old",
		AuthMethod:   "idc",
		Provider:     "BuilderId",
		Region:       "us-east-1",
		ExpiresAt:    time.Now().Add(-time.Hour).Unix(),
		MachineId:    "machine-keep",
		ProxyURL:     "http://127.0.0.1:9",
		Weight:       5,
		Enabled:      true,
		RequestCount: 42,
		TotalTokens:  1000,
		TotalCredits: 3.5,
		LastUsed:     1700000000,
		ErrorCount:   2,

		SubscriptionType: "Q_DEVELOPER_STANDALONE_FREE",
		UsageLimit:       50,
		UsageCurrent:     10,
	}
}

func TestReloginCredentialsReplacesTokensKeepsSettings(t *testing.T) {
	h, fake, verified := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-new", "rt-rotated"
	fake.users["at-new"] = [2]string{"dev@example.com", "user-1"}

	before := time.Now().Unix()
	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if body["relogin"] != true || body["identityVerified"] != true || body["identityReplaced"] != false {
		t.Fatalf("unexpected response: %v", body)
	}
	if got := body["account"].(map[string]interface{})["id"]; got != "acc-1" {
		t.Fatalf("response account id = %v", got)
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d, want 1 (re-login must not add)", n)
	}
	got := storedRelogin(t, "acc-1")
	if got.AccessToken != "at-new" || got.RefreshToken != "rt-rotated" || got.ClientID != "client-x" || got.ClientSecret != "secret-x" {
		t.Fatalf("credentials not replaced: %+v", got)
	}
	if got.ExpiresAt < before+3000 {
		t.Fatalf("ExpiresAt = %d, want about now+3600", got.ExpiresAt)
	}
	if got.Nickname != "Main" || got.Weight != 5 || got.ProxyURL != "http://127.0.0.1:9" || got.MachineId != "machine-keep" {
		t.Fatalf("settings changed: %+v", got)
	}
	if got.RequestCount != 42 || got.TotalTokens != 1000 || got.TotalCredits != 3.5 || got.LastUsed != 1700000000 || got.ErrorCount != 2 {
		t.Fatalf("stats changed: %+v", got)
	}
	if got.SubscriptionType == "" || got.UsageLimit != 50 {
		t.Fatalf("same-user re-login dropped the usage snapshot: %+v", got)
	}
	if got.AuthMethod != "idc" {
		t.Fatalf("AuthMethod = %q", got.AuthMethod)
	}
	select {
	case acc := <-verified:
		if acc.ID != "acc-1" || acc.AccessToken != "at-new" {
			t.Fatalf("verify got %+v", acc)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("re-login did not start the background verify")
	}
}

func TestReloginClearsBanAndCooldownKeepsManualDisable(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	banned := baseReloginAccount("banned")
	banned.Enabled = false
	banned.BanStatus = "BANNED"
	banned.BanReason = "AWS temporarily suspended - unusual user activity detected"
	banned.BanTime = time.Now().Unix()
	addReloginTarget(t, banned)
	manual := baseReloginAccount("manual")
	manual.Enabled = false
	manual.Silent = true
	manual.SilentReason = "manual"
	addReloginTarget(t, manual)
	h.pool.RecordQuotaError("banned", time.Hour)
	if h.pool.CooldownUntil("banned").IsZero() {
		t.Fatal("setup: no cooldown")
	}

	fake.access, fake.refresh = "at-new", "rt-new"
	fake.users["at-new"] = [2]string{"dev@example.com", "user-1"}
	for _, id := range []string{"banned", "manual"} {
		if rec, _ := callRelogin(t, h.apiImportCredentials, idcCredentials(id)); rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body=%s", id, rec.Code, rec.Body.String())
		}
	}

	got := storedRelogin(t, "banned")
	if !got.Enabled || got.BanStatus != "ACTIVE" || got.BanReason != "" || got.BanTime != 0 {
		t.Fatalf("auto ban not cleared: %+v", got)
	}
	if until := h.pool.CooldownUntil("banned"); !until.IsZero() {
		t.Fatalf("cooldown kept until %v", until)
	}
	kept := storedRelogin(t, "manual")
	if kept.Enabled || !kept.Silent || kept.SilentReason != "manual" {
		t.Fatalf("manual disable or silent changed: %+v", kept)
	}
	if kept.AccessToken != "at-new" {
		t.Fatalf("manual account tokens not replaced: %+v", kept)
	}
}

func TestReloginIdentityMismatchStashesThenConfirm(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-other", "rt-other"
	fake.users["at-other"] = [2]string{"someone@example.com", "user-2"}

	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusConflict || body["code"] != codeReloginIdentityMismatch {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if body["currentEmail"] != "dev@example.com" || body["incomingEmail"] != "someone@example.com" || body["accountId"] != "acc-1" {
		t.Fatalf("mismatch body = %v", body)
	}
	if strings.Contains(rec.Body.String(), "at-other") || strings.Contains(rec.Body.String(), "rt-other") {
		t.Fatal("mismatch response leaked tokens")
	}
	pendingID, _ := body["pendingId"].(string)
	if pendingID == "" {
		t.Fatalf("no pendingId: %v", body)
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.Email != "dev@example.com" {
		t.Fatalf("mismatch changed the account: %+v", got)
	}

	rec, body = callPending(h, true, "acc-1", pendingID)
	if rec.Code != http.StatusOK || body["identityReplaced"] != true || body["relogin"] != true {
		t.Fatalf("confirm status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "acc-1")
	// The user lookup's id replaces the old user's.
	if got.AccessToken != "at-other" || got.Email != "someone@example.com" || got.UserId != "user-2" {
		t.Fatalf("confirm did not replace the identity: %+v", got)
	}
	if got.SubscriptionType != "" || got.UsageLimit != 0 || got.UsageCurrent != 0 {
		t.Fatalf("old user's snapshot kept: %+v", got)
	}
	if got.Nickname != "Main" || got.RequestCount != 42 || got.MachineId != "machine-keep" {
		t.Fatalf("settings or stats changed: %+v", got)
	}

	if rec, body := callPending(h, true, "acc-1", pendingID); rec.Code != http.StatusNotFound || body["code"] != codeReloginPendingNotFound {
		t.Fatalf("second confirm status = %d, body=%v", rec.Code, body)
	}
}

func TestReloginDiscardDropsPending(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-other", "rt-other"
	fake.users["at-other"] = [2]string{"someone@example.com", "user-2"}

	_, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	pendingID, _ := body["pendingId"].(string)
	if pendingID == "" {
		t.Fatalf("no pendingId: %v", body)
	}
	if rec, body := callPending(h, false, "acc-1", pendingID); rec.Code != http.StatusOK || body["success"] != true {
		t.Fatalf("discard status = %d, body=%v", rec.Code, body)
	}
	if rec, _ := callPending(h, true, "acc-1", pendingID); rec.Code != http.StatusNotFound {
		t.Fatalf("confirm after discard status = %d", rec.Code)
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" {
		t.Fatalf("discard changed the account: %+v", got)
	}
}

func TestReloginConfirmUnknownPending404(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	addReloginTarget(t, baseReloginAccount("acc-2"))
	if rec, body := callPending(h, true, "acc-1", "nope"); rec.Code != http.StatusNotFound || body["code"] != codeReloginPendingNotFound {
		t.Fatalf("status = %d, body=%v", rec.Code, body)
	}

	// A pending login only applies to the account it was made for.
	fake.access, fake.refresh = "at-other", "rt-other"
	fake.users["at-other"] = [2]string{"someone@example.com", "user-2"}
	_, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	pendingID, _ := body["pendingId"].(string)
	if rec, _ := callPending(h, true, "acc-2", pendingID); rec.Code != http.StatusNotFound {
		t.Fatalf("confirm on another account status = %d", rec.Code)
	}
	if got := storedRelogin(t, "acc-2"); got.AccessToken != "at-old" {
		t.Fatalf("another account's pending login was applied: %+v", got)
	}
}

func TestReloginUnknownTargetRejectedBeforeUpstream(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	const missing = "no-such-account"
	cases := []struct {
		name    string
		handler func(http.ResponseWriter, *http.Request)
		body    map[string]interface{}
	}{
		{"builderid", h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1"}},
		{"iam", h.apiStartIamSso, map[string]interface{}{"startUrl": "https://d-1.awsapps.com/start", "region": "us-east-1"}},
		{"microsoft", h.apiStartMicrosoftSSO, map[string]interface{}{}},
		{"credentials", h.apiImportCredentials, map[string]interface{}{"refreshToken": "rt", "clientId": "c", "clientSecret": "s", "authMethod": "idc"}},
		{"apikey", h.apiImportCredentials, map[string]interface{}{"kiroApiKey": "ksk_abc"}},
		{"sso", h.apiImportSsoToken, map[string]interface{}{"bearerToken": "token", "region": "us-east-1"}},
	}
	for _, tc := range cases {
		tc.body["reloginAccountId"] = missing
		rec, body := callRelogin(t, tc.handler, tc.body)
		if rec.Code != http.StatusNotFound || body["code"] != codeAccountNotFound {
			t.Errorf("%s: status = %d, body=%s", tc.name, rec.Code, rec.Body.String())
		}
	}
	if hits := fake.hitCount(); hits != 0 {
		t.Fatalf("upstream hits = %d, want 0", hits)
	}
	if len(reloginSessions.targets) != 0 {
		t.Fatalf("bindings made for an unknown account: %v", reloginSessions.targets)
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d", n)
	}
}

func TestReloginBuilderIdStartBindsAndEchoes(t *testing.T) {
	h, _, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	rec, body := callRelogin(t, h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1", "reloginAccountId": "acc-1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	sessionID, _ := body["sessionId"].(string)
	if body["reloginAccountId"] != "acc-1" || body["userCode"] != "ABCD-EFGH" || sessionID == "" {
		t.Fatalf("start body = %v", body)
	}
	if got := reloginSessions.target(sessionID); got != "acc-1" {
		t.Fatalf("binding = %q", got)
	}
	// The account is untouched until the login completes.
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" {
		t.Fatalf("start changed the account: %+v", got)
	}

	// Without reloginAccountId the start is a plain add: no binding, no echo.
	rec, body = callRelogin(t, h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("plain start status = %d", rec.Code)
	}
	if _, ok := body["reloginAccountId"]; ok {
		t.Fatalf("plain start echoed reloginAccountId: %v", body)
	}
	if got := reloginSessions.target(body["sessionId"].(string)); got != "" {
		t.Fatalf("plain start bound to %q", got)
	}
}

func TestReloginBuilderIdPollSavesIntoTarget(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	target := baseReloginAccount("acc-1")
	target.Region = "eu-west-1"
	addReloginTarget(t, target)
	_, body := callRelogin(t, h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1", "reloginAccountId": "acc-1"})
	sessionID := body["sessionId"].(string)

	fake.access, fake.refresh = "at-device", "rt-device"
	fake.users["at-device"] = [2]string{"DEV@example.com", ""}
	rec, body := callRelogin(t, h.apiPollBuilderIdAuth, map[string]interface{}{"sessionId": sessionID})
	if rec.Code != http.StatusOK {
		t.Fatalf("poll status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if body["completed"] != true || body["relogin"] != true || body["identityVerified"] != true {
		t.Fatalf("poll body = %v", body)
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d, want 1", n)
	}
	got := storedRelogin(t, "acc-1")
	if got.AccessToken != "at-device" || got.RefreshToken != "rt-device" || got.ClientID != "client-new" || got.Region != "us-east-1" || got.Provider != "BuilderId" {
		t.Fatalf("poll did not replace the login: %+v", got)
	}
	if got.Email != "DEV@example.com" || got.UserId != "user-1" {
		t.Fatalf("identity fields = %q / %q", got.Email, got.UserId)
	}
	if reloginSessions.target(sessionID) != "" {
		t.Fatal("binding kept after completion")
	}
}

func TestReloginIamStartAndCompleteSavesIntoTarget(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	target := baseReloginAccount("acc-1")
	target.Provider = "Enterprise"
	addReloginTarget(t, target)
	rec, body := callRelogin(t, h.apiStartIamSso, map[string]interface{}{
		"startUrl": "https://d-1.awsapps.com/start", "region": "us-east-1", "reloginAccountId": "acc-1",
	})
	if rec.Code != http.StatusOK || body["reloginAccountId"] != "acc-1" {
		t.Fatalf("start status = %d, body=%s", rec.Code, rec.Body.String())
	}
	sessionID := body["sessionId"].(string)
	authorize, err := url.Parse(body["authorizeUrl"].(string))
	if err != nil {
		t.Fatalf("authorize URL: %v", err)
	}
	state := authorize.Query().Get("state")

	fake.access, fake.refresh = "at-iam", "rt-iam"
	fake.users["at-iam"] = [2]string{"dev@example.com", "user-1"}
	rec, body = callRelogin(t, h.apiCompleteIamSso, map[string]interface{}{
		"sessionId": sessionID, "callbackUrl": "http://127.0.0.1/oauth/callback?code=abc&state=" + state,
	})
	if rec.Code != http.StatusOK || body["relogin"] != true {
		t.Fatalf("complete status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "acc-1")
	if got.AccessToken != "at-iam" || got.Provider != "Enterprise" || got.AuthMethod != "idc" {
		t.Fatalf("complete did not replace the login: %+v", got)
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d, want 1", n)
	}
}

func TestReloginSsoTokenRejectsMultipleLines(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	rec, body := callRelogin(t, h.apiImportSsoToken, map[string]interface{}{
		"bearerToken": "token-a\n\ntoken-b", "region": "us-east-1", "reloginAccountId": "acc-1",
	})
	if rec.Code != http.StatusBadRequest || body["code"] != codeReloginSingleCredential {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if hits := fake.hitCount(); hits != 0 {
		t.Fatalf("upstream hits = %d", hits)
	}
}

func TestReloginAPIKeyReplacesKeyAndRejectsDuplicate(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, config.Account{ID: "key-a", Nickname: "CLI", KiroApiKey: "ksk_old", Weight: 3, Enabled: true})
	addReloginTarget(t, config.Account{ID: "key-b", KiroApiKey: "ksk_other", Enabled: true})
	before := storedRelogin(t, "key-a")
	if before.MachineId != config.MachineIdFromAPIKey("ksk_old") {
		t.Fatalf("setup: machine id %q", before.MachineId)
	}

	rec, body := callRelogin(t, h.apiImportCredentials, map[string]interface{}{"kiroApiKey": "ksk_new|eu-central-1", "reloginAccountId": "key-a"})
	if rec.Code != http.StatusOK || body["relogin"] != true || body["identityVerified"] != false {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "key-a")
	if got.KiroApiKey != "ksk_new" || got.AccessToken != "ksk_new" || got.Region != "eu-central-1" || got.Nickname != "CLI" || got.Weight != 3 {
		t.Fatalf("key not replaced in place: %+v", got)
	}
	if got.MachineId != config.MachineIdFromAPIKey("ksk_new") {
		t.Fatal("a machine id derived from the old key did not follow the new key")
	}
	if got.Email != "api-key-"+config.KiroAPIKeyFingerprint("ksk_new")[:12] {
		t.Fatalf("label = %q", got.Email)
	}

	rec, body = callRelogin(t, h.apiImportCredentials, map[string]interface{}{"kiroApiKey": "ksk_other", "reloginAccountId": "key-a"})
	if rec.Code != http.StatusConflict || body["code"] != codeKiroAPIKeyDuplicate {
		t.Fatalf("duplicate status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "key-a"); got.KiroApiKey != "ksk_new" {
		t.Fatalf("duplicate changed the account: %+v", got)
	}
	// Its own key again is not a duplicate.
	if rec, _ := callRelogin(t, h.apiImportCredentials, map[string]interface{}{"kiroApiKey": "ksk_new", "region": "eu-central-1", "reloginAccountId": "key-a"}); rec.Code != http.StatusOK {
		t.Fatalf("same key status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if hits := fake.hitCount(); hits != 0 {
		t.Fatalf("API key re-login hit upstream %d times", hits)
	}
}

// reloginMicrosoftSignIn runs a Microsoft re-login of targetID through both callbacks: the Entra
// user oid/email signs in, and Kiro offers profileARNs in us-east-1. It returns the session id,
// the second leg's response and the new access token.
func reloginMicrosoftSignIn(t *testing.T, h *Handler, targetID, oid, email string, profileARNs ...string) (string, *httptest.ResponseRecorder, map[string]interface{}, string) {
	t.Helper()
	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	accessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss": issuerURL, "oid": oid,
		"preferred_username": email, "exp": time.Now().Add(time.Hour).Unix(),
	})
	prevAuth := auth.SetGlobalAuthClientForTest(&http.Client{Timeout: time.Second, Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch {
		case request.Method == http.MethodGet && request.URL.String() == issuerURL+"/.well-known/openid-configuration":
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"issuer": issuerURL, "authorization_endpoint": handlerMicrosoftAuthorizationEndpoint(), "token_endpoint": tokenEndpoint,
			}), nil
		case request.Method == http.MethodPost && request.URL.String() == tokenEndpoint:
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"access_token": accessToken, "refresh_token": "new-refresh", "expires_in": 3600, "token_type": "Bearer",
			}), nil
		}
		return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
	})})
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(prevAuth) })
	stubRestTransport(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/ListAvailableProfiles" {
			return nil, fmt.Errorf("unexpected Kiro REST request: %s", request.URL)
		}
		profiles := []map[string]string{}
		if request.URL.Hostname() == "codewhisperer.us-east-1.amazonaws.com" {
			for i, arn := range profileARNs {
				profiles = append(profiles, map[string]string{"arn": arn, "profileName": fmt.Sprintf("P%d", i)})
			}
		}
		return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{"profiles": profiles}), nil
	})

	rec, body := callRelogin(t, h.apiStartMicrosoftSSO, map[string]interface{}{"reloginAccountId": targetID})
	if rec.Code != http.StatusOK || body["reloginAccountId"] != targetID {
		t.Fatalf("start status = %d, body=%s", rec.Code, rec.Body.String())
	}
	sessionID := body["sessionId"].(string)
	t.Cleanup(func() { auth.CancelMicrosoftSSOLogin(sessionID) })
	portalState := mustHandlerMicrosoftURL(t, body["authorizeUrl"].(string)).Query().Get("state")
	portalCallback := url.URL{Scheme: "http", Host: "localhost:3128", Path: "/signin/callback", RawQuery: url.Values{
		"state": {portalState}, "login_option": {auth.MicrosoftSSOAuthMethod}, "issuer_url": {issuerURL},
		"client_id": {handlerMicrosoftClientID}, "scopes": {scopes}, "login_hint": {email},
	}.Encode()}
	first := callMicrosoftCompleteHandler(t, h, sessionID, portalCallback.String())
	var firstBody map[string]interface{}
	decodeHandlerMicrosoftJSON(t, first, &firstBody)
	if first.Code != http.StatusOK || firstBody["stage"] != "microsoft" {
		t.Fatalf("first leg status = %d, body=%s", first.Code, first.Body.String())
	}
	providerState := mustHandlerMicrosoftURL(t, firstBody["authorizeUrl"].(string)).Query().Get("state")
	providerCallback := url.URL{Scheme: "http", Host: "localhost:3128", Path: "/oauth/callback", RawQuery: url.Values{
		"state": {providerState}, "code": {"provider-code"},
	}.Encode()}
	second := callMicrosoftCompleteHandler(t, h, sessionID, providerCallback.String())
	var done map[string]interface{}
	decodeHandlerMicrosoftJSON(t, second, &done)
	return sessionID, second, done, accessToken
}

// entraUserID is the stored user id of an Entra login: <issuer>.<oid>.
func entraUserID(oid string) string {
	return handlerMicrosoftIssuerURL() + "." + oid
}

func entraReloginTarget(id, oid, email string) config.Account {
	return config.Account{
		ID: id, Email: email, UserId: entraUserID(oid), Nickname: "Entra",
		AccessToken: "old", RefreshToken: "old-refresh", ClientID: handlerMicrosoftClientID,
		AuthMethod: auth.MicrosoftSSOAuthMethod, Provider: auth.MicrosoftSSOProvider, Region: "us-east-1",
		Enabled: true,
	}
}

func TestReloginMicrosoftCompleteSavesIntoTarget(t *testing.T) {
	h, _, _ := newReloginHandler(t)
	target := entraReloginTarget("entra-1", handlerMicrosoftObjectID, "enterprise@example.com")
	target.Enabled, target.BanStatus, target.BanReason = false, "BANNED", "Authentication failed - token invalid or expired"
	addReloginTarget(t, target)

	const usProfile = "arn:aws:codewhisperer:us-east-1:123456789012:profile/us-profile"
	_, second, done, accessToken := reloginMicrosoftSignIn(t, h, "entra-1", handlerMicrosoftObjectID, "enterprise@example.com", usProfile)
	if second.Code != http.StatusOK || done["stage"] != "complete" || done["relogin"] != true || done["identityVerified"] != true {
		t.Fatalf("second leg status = %d, body=%s", second.Code, second.Body.String())
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d, want 1", n)
	}
	got := storedRelogin(t, "entra-1")
	if got.AccessToken != accessToken || got.RefreshToken != "new-refresh" || got.ProfileArn != usProfile || got.TokenEndpoint != handlerMicrosoftTokenEndpoint() {
		t.Fatalf("login not replaced: %+v", got)
	}
	if !got.Enabled || got.BanStatus != "ACTIVE" || got.Nickname != "Entra" {
		t.Fatalf("ban or settings wrong: %+v", got)
	}
}

func TestReloginMicrosoftSelectProfileSavesIntoTarget(t *testing.T) {
	const (
		profileA = "arn:aws:codewhisperer:us-east-1:123456789012:profile/a"
		profileB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/b"
	)

	t.Run("same user: the picked profile replaces the pinned one", func(t *testing.T) {
		h, _, _ := newReloginHandler(t)
		target := entraReloginTarget("entra-1", handlerMicrosoftObjectID, "enterprise@example.com")
		target.ProfileArn, target.ProfileArnPinned = profileA, true
		addReloginTarget(t, target)

		sessionID, second, done, accessToken := reloginMicrosoftSignIn(t, h, "entra-1", handlerMicrosoftObjectID, "enterprise@example.com", profileA, profileB)
		if second.Code != http.StatusOK || done["stage"] != "profile" {
			t.Fatalf("second leg status = %d, body=%s", second.Code, second.Body.String())
		}
		selectionID := done["selectionId"].(string)
		if got := storedRelogin(t, "entra-1"); got.AccessToken != "old" {
			t.Fatalf("the profile step saved early: %+v", got)
		}

		rec := callMicrosoftProfileSelectionHandler(t, h, selectionID, profileB)
		var body map[string]interface{}
		decodeHandlerMicrosoftJSON(t, rec, &body)
		if rec.Code != http.StatusOK || body["stage"] != "complete" || body["relogin"] != true || body["identityVerified"] != true {
			t.Fatalf("select status = %d, body=%s", rec.Code, rec.Body.String())
		}
		got := storedRelogin(t, "entra-1")
		if got.AccessToken != accessToken || got.ProfileArn != profileB || !got.ProfileArnPinned || got.Nickname != "Entra" {
			t.Fatalf("selection not saved into the target: %+v", got)
		}
		if n := len(config.GetAccounts()); n != 1 {
			t.Fatalf("accounts = %d, want 1", n)
		}
		if pendingMicrosoftSelection(selectionID) != nil || reloginSessions.target(sessionID) != "" {
			t.Fatal("selection or binding kept after a saved re-login")
		}
	})

	t.Run("other user: stashed, then confirmed", func(t *testing.T) {
		h, _, _ := newReloginHandler(t)
		addReloginTarget(t, entraReloginTarget("entra-1", "11111111-2222-4333-8444-555555555555", "first@example.com"))

		sessionID, second, done, accessToken := reloginMicrosoftSignIn(t, h, "entra-1", handlerMicrosoftObjectID, "enterprise@example.com", profileA, profileB)
		if second.Code != http.StatusOK || done["stage"] != "profile" {
			t.Fatalf("second leg status = %d, body=%s", second.Code, second.Body.String())
		}
		selectionID := done["selectionId"].(string)

		rec := callMicrosoftProfileSelectionHandler(t, h, selectionID, profileB)
		var body map[string]interface{}
		decodeHandlerMicrosoftJSON(t, rec, &body)
		if rec.Code != http.StatusConflict || body["code"] != codeReloginIdentityMismatch || body["incomingEmail"] != "enterprise@example.com" {
			t.Fatalf("select status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if got := storedRelogin(t, "entra-1"); got.AccessToken != "old" || got.UserId != entraUserID("11111111-2222-4333-8444-555555555555") {
			t.Fatalf("mismatch changed the account: %+v", got)
		}
		// The login now waits in the stash; the selection and the binding are used up.
		if pendingMicrosoftSelection(selectionID) != nil || reloginSessions.target(sessionID) != "" {
			t.Fatal("selection or binding kept after the login was stashed")
		}

		rec, body = callPending(h, true, "entra-1", body["pendingId"].(string))
		if rec.Code != http.StatusOK || body["identityReplaced"] != true {
			t.Fatalf("confirm status = %d, body=%s", rec.Code, rec.Body.String())
		}
		got := storedRelogin(t, "entra-1")
		if got.AccessToken != accessToken || got.UserId != entraUserID(handlerMicrosoftObjectID) || got.Email != "enterprise@example.com" || got.ProfileArn != profileB || got.ProfileArnPinned {
			t.Fatalf("confirm did not apply the picked login: %+v", got)
		}
	})
}

func TestReloginMicrosoftRefusesAnotherAccountsEntraUser(t *testing.T) {
	const (
		profileA = "arn:aws:codewhisperer:us-east-1:123456789012:profile/a"
		profileB = "arn:aws:codewhisperer:us-east-1:123456789012:profile/b"
	)
	h, _, _ := newReloginHandler(t)
	// The same person as a Builder ID account (same email, so the identity matches) and as an
	// Entra account that already exists.
	target := baseReloginAccount("acc-1")
	target.Email = "enterprise@example.com"
	addReloginTarget(t, target)
	addReloginTarget(t, entraReloginTarget("entra-2", handlerMicrosoftObjectID, "enterprise@example.com"))

	sessionID, second, done, accessToken := reloginMicrosoftSignIn(t, h, "acc-1", handlerMicrosoftObjectID, "enterprise@example.com", profileA, profileB)
	if second.Code != http.StatusOK || done["stage"] != "profile" {
		t.Fatalf("second leg status = %d, body=%s", second.Code, second.Body.String())
	}
	selectionID := done["selectionId"].(string)

	rec := callMicrosoftProfileSelectionHandler(t, h, selectionID, profileA)
	var body map[string]interface{}
	decodeHandlerMicrosoftJSON(t, rec, &body)
	if rec.Code != http.StatusConflict || body["code"] != codeMicrosoftDuplicate {
		t.Fatalf("select status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.AuthMethod != "idc" || got.UserId != "user-1" {
		t.Fatalf("duplicate changed the target: %+v", got)
	}
	// A refused save keeps the selection and the binding, so the admin can try again.
	if pendingMicrosoftSelection(selectionID) == nil || reloginSessions.target(sessionID) != "acc-1" {
		t.Fatal("a refused save used up the selection or the binding")
	}

	if err := config.DeleteAccount("entra-2"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rec = callMicrosoftProfileSelectionHandler(t, h, selectionID, profileA)
	if rec.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "acc-1")
	if got.AccessToken != accessToken || got.UserId != entraUserID(handlerMicrosoftObjectID) || !config.IsExternalIdpAccount(&got) || got.ProfileArn != profileA {
		t.Fatalf("retry did not save the Entra login: %+v", got)
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("accounts = %d, want 1", n)
	}
}

func TestReloginUserIdMismatchWithoutEmail(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-other", "rt-other"
	fake.users["at-other"] = [2]string{"", "user-2"}

	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusConflict || body["code"] != codeReloginIdentityMismatch {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}

	_, body = callRelogin(t, h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1", "reloginAccountId": "acc-1"})
	rec, body = callRelogin(t, h.apiPollBuilderIdAuth, map[string]interface{}{"sessionId": body["sessionId"].(string)})
	if rec.Code != http.StatusConflict || body["code"] != codeReloginIdentityMismatch {
		t.Fatalf("Builder ID status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "acc-1"); got.AccessToken != "at-old" || got.UserId != "user-1" {
		t.Fatalf("mismatch changed the account: %+v", got)
	}

	rec, body = callPending(h, true, "acc-1", body["pendingId"].(string))
	if rec.Code != http.StatusOK || body["identityReplaced"] != true {
		t.Fatalf("confirm status = %d, body=%s", rec.Code, rec.Body.String())
	}
	// The other user's email is not known yet: the old user's does not stay on the account.
	if got := storedRelogin(t, "acc-1"); got.UserId != "user-2" || got.Email != "" {
		t.Fatalf("confirmed identity = %q / %q", got.Email, got.UserId)
	}
}

func TestReloginKeepsPinnedProfileSameIdentity(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	const pinned = "arn:aws:codewhisperer:us-east-1:123456789012:profile/pinned"
	target := baseReloginAccount("acc-1")
	target.Provider = ""
	target.ProfileArn = pinned
	target.ProfileArnPinned = true
	addReloginTarget(t, target)
	fake.access, fake.refresh, fake.arn = "at-new", "rt-new", "arn:aws:codewhisperer:us-east-1:123456789012:profile/other"
	fake.users["at-new"] = [2]string{"dev@example.com", "user-1"}

	if rec, _ := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1")); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := storedRelogin(t, "acc-1"); got.ProfileArn != pinned || !got.ProfileArnPinned {
		t.Fatalf("pin lost: %q pinned=%v", got.ProfileArn, got.ProfileArnPinned)
	}

	// A profile the admin picked in this sign-in replaces the pinned one and stays pinned.
	picked := mergeRelogin(target, config.Account{AuthMethod: "idc", ProfileArn: fake.arn, ProfileArnPinned: true}, false)
	if picked.ProfileArn != fake.arn || !picked.ProfileArnPinned {
		t.Fatalf("picked profile lost to the pin: %q pinned=%v", picked.ProfileArn, picked.ProfileArnPinned)
	}

	// Another login method is a new credential: the pin goes, the new ARN is taken.
	merged := mergeRelogin(target, config.Account{AuthMethod: "social", Provider: "Google", ProfileArn: fake.arn}, false)
	if merged.ProfileArn != fake.arn || merged.ProfileArnPinned {
		t.Fatalf("method change kept the pin: %q pinned=%v", merged.ProfileArn, merged.ProfileArnPinned)
	}
}

func TestReloginUnverifiedIdentityProceeds(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	fake.access, fake.refresh = "at-new", "rt-new"
	fake.failInfo = true

	rec, body := callRelogin(t, h.apiImportCredentials, idcCredentials("acc-1"))
	if rec.Code != http.StatusOK || body["identityVerified"] != false {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := storedRelogin(t, "acc-1")
	if got.AccessToken != "at-new" || got.Email != "dev@example.com" || got.UserId != "user-1" {
		t.Fatalf("unverified re-login: %+v", got)
	}
}

func TestMergeReloginClearsSnapshotsOnReplace(t *testing.T) {
	current := baseReloginAccount("acc-1")
	current.OverageStatus = "ENABLED"
	current.TrialStatus = "ACTIVE"
	current.ProfileArn = "arn:aws:codewhisperer:us-east-1:1:profile/p"
	current.ProfileArnPinned = true
	current.StartUrl = "https://d-1.awsapps.com/start"
	incoming := config.Account{
		ID: "ignored", Email: "new@example.com", AccessToken: "a", RefreshToken: "r",
		AuthMethod: "social", Provider: "Google", Region: "us-east-1", Nickname: "ignored", MachineId: "ignored",
	}

	merged := mergeRelogin(current, incoming, true)
	if merged.ID != "acc-1" || merged.Nickname != "Main" || merged.MachineId != "machine-keep" || merged.Weight != 5 {
		t.Fatalf("kept fields changed: %+v", merged)
	}
	if merged.Email != "new@example.com" || merged.UserId != "" {
		t.Fatalf("identity = %q / %q", merged.Email, merged.UserId)
	}
	if merged.SubscriptionType != "" || merged.UsageLimit != 0 || merged.OverageStatus != "" || merged.TrialStatus != "" {
		t.Fatalf("snapshots kept: %+v", merged)
	}
	if merged.ProfileArn != "" || merged.ProfileArnPinned || merged.StartUrl != "" {
		t.Fatalf("profile or start URL kept: %+v", merged)
	}
	if merged.ClientID != "" || merged.ClientSecret != "" {
		t.Fatalf("stale client kept after a method change: %+v", merged)
	}
	if merged.RequestCount != 42 || merged.TotalCredits != 3.5 {
		t.Fatalf("stats changed: %+v", merged)
	}

	same := mergeRelogin(current, config.Account{AuthMethod: "idc", Provider: "BuilderId", AccessToken: "a"}, false)
	if same.SubscriptionType == "" || same.Email != "dev@example.com" || same.StartUrl != current.StartUrl {
		t.Fatalf("same-user merge dropped data: %+v", same)
	}
}

func TestReloginIdentityRules(t *testing.T) {
	cases := []struct {
		name            string
		current, in     config.Account
		match, verified bool
	}{
		{"same user id", config.Account{UserId: "u"}, config.Account{UserId: "u", Email: "x@y"}, true, true},
		{"email differs in case", config.Account{Email: "A@x.com"}, config.Account{Email: "a@X.com"}, true, true},
		{"other user", config.Account{UserId: "u", Email: "a@x"}, config.Account{UserId: "v", Email: "b@x"}, false, true},
		{"nothing to compare", config.Account{Email: "a@x"}, config.Account{}, true, false},
		{"key labels never decide", config.Account{Email: "api-key-aaaa"}, config.Account{Email: "api-key-bbbb"}, true, false},
		{"entra and kiro ids are not compared", config.Account{UserId: "kiro-u", Email: "a@x"},
			config.Account{UserId: "oid", AuthMethod: auth.MicrosoftSSOAuthMethod, Email: "a@x"}, true, true},
		{"same email, other user id", config.Account{UserId: "u", Email: "a@x"},
			config.Account{UserId: "v", Email: "A@x"}, false, true},
		{"same email, other social provider", config.Account{AuthMethod: "social", Provider: "Google", Email: "a@x"},
			config.Account{AuthMethod: "social", Provider: "Github", Email: "a@x"}, false, true},
		{"same email, social provider not named", config.Account{AuthMethod: "social", Provider: "Google", Email: "a@x"},
			config.Account{AuthMethod: "social", Email: "a@x"}, true, true},
		{"entra id replaced by kiro's, same tenant",
			config.Account{UserId: "kiro-u", AuthMethod: auth.MicrosoftSSOAuthMethod, Email: "a@x", IssuerURL: "https://login.example/t1/v2.0"},
			config.Account{UserId: "oid", AuthMethod: auth.MicrosoftSSOAuthMethod, Email: "a@x", IssuerURL: "https://login.example/t1/v2.0/"}, true, true},
		{"entra user of another tenant",
			config.Account{UserId: "oid-1", AuthMethod: auth.MicrosoftSSOAuthMethod, Email: "a@x", IssuerURL: "https://login.example/t1/v2.0"},
			config.Account{UserId: "oid-2", AuthMethod: auth.MicrosoftSSOAuthMethod, Email: "a@x", IssuerURL: "https://login.example/t2/v2.0"}, false, true},
	}
	for _, tc := range cases {
		match, verified := reloginIdentity(tc.current, tc.in)
		if match != tc.match || verified != tc.verified {
			t.Errorf("%s: match=%v verified=%v, want %v %v", tc.name, match, verified, tc.match, tc.verified)
		}
	}
}

func TestReloginTargetDeletedMidFlow(t *testing.T) {
	h, fake, _ := newReloginHandler(t)
	addReloginTarget(t, baseReloginAccount("acc-1"))
	_, body := callRelogin(t, h.apiStartBuilderIdLogin, map[string]interface{}{"region": "us-east-1", "reloginAccountId": "acc-1"})
	sessionID := body["sessionId"].(string)
	if err := config.DeleteAccount("acc-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	fake.access, fake.refresh = "at-device", "rt-device"
	rec, body := callRelogin(t, h.apiPollBuilderIdAuth, map[string]interface{}{"sessionId": sessionID})
	if rec.Code != http.StatusNotFound || body["code"] != codeAccountNotFound {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if n := len(config.GetAccounts()); n != 0 {
		t.Fatalf("a deleted target's login was added as a new account (%d)", n)
	}
}

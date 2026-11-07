package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

const (
	testAutoProfileArn   = "arn:aws:codewhisperer:us-east-1:123456789012:profile/AUTO"
	testPinnedProfileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/FRANKFURT"
)

func newAccountProfileTestHandler(t *testing.T) *Handler {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("admin-password")
	//! The handler re-applies the proxy config, which replaces the REST client; stub after it.
	h := newHandlerWithoutBackgroundForTest(t)
	kiroRestHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/ListAvailableProfiles" {
			t.Errorf("unexpected upstream path %s", req.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"profiles":[` +
				`{"arn":"` + testAutoProfileArn + `","profileName":"Virginia"},` +
				`{"arn":"` + testPinnedProfileArn + `","profileName":"Frankfurt"}]}`)),
		}, nil
	})})
	t.Cleanup(func() { InitKiroHttpClient("") })
	return h
}

func callAccountProfileAPI(t *testing.T, h *Handler, method, path, body string) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(method, "/admin/api"+path, strings.NewReader(body))
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var decoded map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
	return rec, decoded
}

func TestAccountProfileListAndPin(t *testing.T) {
	h := newAccountProfileTestHandler(t)
	account := config.Account{ID: "oauth", Enabled: true, AuthMethod: "social", AccessToken: "token", RefreshToken: "refresh", ProfileArn: testAutoProfileArn}
	if err := config.AddAccount(account); err != nil {
		t.Fatal(err)
	}
	h.pool.Reload()

	rec, got := callAccountProfileAPI(t, h, http.MethodGet, "/accounts/oauth/profiles", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", rec.Code, rec.Body.String())
	}
	profiles, _ := got["profiles"].([]interface{})
	if len(profiles) != 2 || got["pinned"] != false || got["currentArn"] != testAutoProfileArn || got["activeRegion"] != "us-east-1" {
		t.Fatalf("unexpected list response: %s", rec.Body.String())
	}
	first, _ := profiles[0].(map[string]interface{})
	if first["arn"] != testAutoProfileArn || first["current"] != true || first["region"] != "us-east-1" {
		t.Fatalf("current profile not marked: %s", rec.Body.String())
	}

	for _, body := range []string{
		`{"profileArn":"arn:aws:codewhisperer:eu-central-1:123456789012:profile/NOT-OWNED"}`,
		`{"profileArn":"arn:aws:codewhisperer:evil.example:123456789012:profile/X"}`,
		`not json`,
	} {
		rec, _ = callAccountProfileAPI(t, h, http.MethodPost, "/accounts/oauth/profile", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400 (%s)", body, rec.Code, rec.Body.String())
		}
	}
	if got := findAccountByID("oauth"); got.ProfileArn != testAutoProfileArn || got.ProfileArnPinned {
		t.Fatalf("rejected pin changed the account: %+v", got)
	}

	rec, got = callAccountProfileAPI(t, h, http.MethodPost, "/accounts/oauth/profile", `{"profileArn":" `+testPinnedProfileArn+` "}`)
	if rec.Code != http.StatusOK || got["pinned"] != true || got["region"] != "eu-central-1" {
		t.Fatalf("pin status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := findAccountByID("oauth"); got.ProfileArn != testPinnedProfileArn || !got.ProfileArnPinned {
		t.Fatalf("pin not persisted: %+v", got)
	}
	if live := h.pool.GetByID("oauth"); live == nil || live.ProfileArn != testPinnedProfileArn {
		t.Fatalf("pool still routes the old profile: %+v", live)
	}

	rec, _ = callAccountProfileAPI(t, h, http.MethodGet, "/accounts", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"profileArnPinned":true`) || !strings.Contains(rec.Body.String(), `"activeRegion":"eu-central-1"`) {
		t.Fatalf("account list lacks pin state: %s", rec.Body.String())
	}

	rec, got = callAccountProfileAPI(t, h, http.MethodPost, "/accounts/oauth/profile", `{"profileArn":""}`)
	if rec.Code != http.StatusOK || got["pinned"] != false {
		t.Fatalf("unpin status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := findAccountByID("oauth"); got.ProfileArn != "" || got.ProfileArnPinned {
		t.Fatalf("unpin did not return to automatic: %+v", got)
	}
}

func TestAccountProfileRejectsAPIKeyAndMissingAccounts(t *testing.T) {
	h := newAccountProfileTestHandler(t)
	if err := config.AddAccount(config.Account{ID: "key", Enabled: true, AuthMethod: "api_key", KiroApiKey: "ksk_test", Region: "us-east-1"}); err != nil {
		t.Fatal(err)
	}
	rec, _ := callAccountProfileAPI(t, h, http.MethodGet, "/accounts/key/profiles", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("api key list status = %d body = %s", rec.Code, rec.Body.String())
	}
	rec, _ = callAccountProfileAPI(t, h, http.MethodPost, "/accounts/key/profile", `{"profileArn":"`+testPinnedProfileArn+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("api key pin status = %d body = %s", rec.Code, rec.Body.String())
	}
	rec, _ = callAccountProfileAPI(t, h, http.MethodGet, "/accounts/missing/profiles", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing list status = %d", rec.Code)
	}
}

func TestRefreshKeepsPinnedProfileArn(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	account := config.Account{ID: "pinned", Enabled: true, AuthMethod: "idc", AccessToken: "old", RefreshToken: "old-refresh", ClientID: "client", ClientSecret: "secret", ExpiresAt: 1}
	if err := config.AddAccount(account); err != nil {
		t.Fatal(err)
	}
	if err := config.PinAccountProfileArn(account.ID, testPinnedProfileArn); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"accessToken":"new","refreshToken":"new-refresh","expiresIn":3600,"profileArn":"` + testAutoProfileArn + `"}`))
	}))
	defer server.Close()
	oldURL := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return server.URL })
	defer auth.SetOIDCTokenURLForTest(oldURL)
	oldClient := auth.SetGlobalAuthClientForTest(server.Client())
	defer auth.SetGlobalAuthClientForTest(oldClient)

	if err := refreshStoredAccount(context.Background(), &account, true); err != nil {
		t.Fatal(err)
	}
	if account.AccessToken != "new" || account.ProfileArn != testPinnedProfileArn || !account.ProfileArnPinned {
		t.Fatalf("refresh replaced the pinned profile: %+v", account)
	}
}

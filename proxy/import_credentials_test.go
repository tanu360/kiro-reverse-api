package proxy

import (
	"encoding/json"
	"fmt"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func installCleanAuthClient(t *testing.T) func() {
	t.Helper()
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	prev := auth.SetGlobalAuthClientForTest(c)
	return func() { auth.SetGlobalAuthClientForTest(prev) }
}

func TestApiImportCredentialsRejectsWhenRefreshFails(t *testing.T) {
	cfgFile := tempDataDir(t) + "/config.json"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	defer installCleanAuthClient(t)()

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
	}))
	defer fake.Close()

	oldOIDC := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return fake.URL })
	defer auth.SetOIDCTokenURLForTest(oldOIDC)

	h := &Handler{pool: accountpool.GetPool()}
	body := `{"refreshToken":"rt-broken","accessToken":"at-still-valid-elsewhere","clientId":"c","clientSecret":"s","authMethod":"idc","region":"us-east-1"}`
	req := httptest.NewRequest("POST", "/auth/credentials", strings.NewReader(body))
	rec := httptest.NewRecorder()

	h.apiImportCredentials(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when refresh fails, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.Contains(resp["error"], "Token refresh failed") {
		t.Fatalf("expected refresh-failed error, got %q", resp["error"])
	}
	if accs := config.GetAccounts(); len(accs) != 0 {
		t.Fatalf("expected no accounts to be persisted on failed import, got %+v", accs)
	}
}

func TestApiImportCredentialsUsesUpstreamExpiresAt(t *testing.T) {
	cfgFile := tempDataDir(t) + "/config.json"
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	defer installCleanAuthClient(t)()

	const upstreamExpiresIn = 3600
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"accessToken":"at-new","refreshToken":"rt-rotated","expiresIn":%d,"profileArn":"arn:aws:codewhisperer:profile/test"}`, upstreamExpiresIn)
	}))
	defer fake.Close()

	oldOIDC := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return fake.URL })
	defer auth.SetOIDCTokenURLForTest(oldOIDC)

	h := &Handler{pool: accountpool.GetPool()}
	before := time.Now().Unix()
	body := `{"refreshToken":"rt-good","clientId":"c","clientSecret":"s","authMethod":"idc","region":"us-east-1"}`
	req := httptest.NewRequest("POST", "/auth/credentials", strings.NewReader(body))
	rec := httptest.NewRecorder()

	h.apiImportCredentials(rec, req)
	after := time.Now().Unix()

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on successful refresh, got %d body=%s", rec.Code, rec.Body.String())
	}
	accs := config.GetAccounts()
	if len(accs) != 1 {
		t.Fatalf("expected exactly one account persisted, got %d", len(accs))
	}
	got := accs[0]
	if got.AccessToken != "at-new" {
		t.Fatalf("expected upstream-issued accessToken, got %q", got.AccessToken)
	}
	if got.RefreshToken != "rt-rotated" {
		t.Fatalf("expected rotated refreshToken to be persisted, got %q", got.RefreshToken)
	}
	expectMin := before + upstreamExpiresIn - 5
	expectMax := after + upstreamExpiresIn + 5
	if got.ExpiresAt < expectMin || got.ExpiresAt > expectMax {
		t.Fatalf("expected ExpiresAt around now+%d ([%d..%d]), got %d", upstreamExpiresIn, expectMin, expectMax, got.ExpiresAt)
	}
}

// stubImportNetwork blocks every outbound call an API key import could make.
// OAuth refresh must never run for an API key, so reaching it fails the test.
// The returned channel receives the Authorization header of the background
// model-list request, which lets a test wait for that goroutine to finish.
func stubImportNetwork(t *testing.T) <-chan string {
	t.Helper()
	t.Cleanup(installCleanAuthClient(t))
	refresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("API key import must not call OAuth refresh (%s)", r.URL)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	t.Cleanup(refresh.Close)
	oldOIDC := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return refresh.URL })
	t.Cleanup(func() { auth.SetOIDCTokenURLForTest(oldOIDC) })

	//! The stub is the package's one REST client, so a background refresh another test started can
	//! land here too. The send never blocks on a full buffer, and waitForModelRefresh skips calls
	//! it is not waiting for.
	modelCalls := make(chan string, 64)
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		select {
		case modelCalls <- req.Header.Get("Authorization"):
		default:
		}
		return nil, fmt.Errorf("network disabled in test")
	})
	return modelCalls
}

func importCredentials(h *Handler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/auth/credentials", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.apiImportCredentials(rec, req)
	return rec
}

// waitForModelRefresh waits for a REST call that carries wantAuth. Calls with another
// Authorization are a refresh some earlier test left running, and are skipped.
func waitForModelRefresh(t *testing.T, calls <-chan string, wantAuth string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	var others []string
	for {
		select {
		case got := <-calls:
			if got == wantAuth {
				return
			}
			others = append(others, got)
		case <-deadline:
			t.Fatalf("expected a background model refresh with Authorization %q; saw only %q", wantAuth, others)
		}
	}
}

// drainModelCalls drops the calls received so far, so the next wait sees only later ones.
func drainModelCalls(calls <-chan string) {
	for {
		select {
		case <-calls:
		default:
			return
		}
	}
}

func TestApiImportCredentialsAPIKeySuccess(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	modelCalls := stubImportNetwork(t)
	h := &Handler{pool: accountpool.GetPool()}

	rec := importCredentials(h, `{"kiroApiKey":"ksk_test_import|eu-central-1","authMethod":"api_key","nickname":"cli-key"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_test_import")

	accs := config.GetAccounts()
	if len(accs) != 1 {
		t.Fatalf("expected 1 account, got %d", len(accs))
	}
	got := accs[0]
	if got.AuthMethod != config.AuthMethodAPIKey || got.KiroApiKey != "ksk_test_import" || got.AccessToken != "ksk_test_import" {
		t.Fatalf("unexpected account: authMethod=%q key=%q accessToken=%q", got.AuthMethod, got.KiroApiKey, got.AccessToken)
	}
	if got.Region != "eu-central-1" || got.Nickname != "cli-key" {
		t.Fatalf("region=%q nickname=%q", got.Region, got.Nickname)
	}
	if got.RefreshToken != "" || got.ExpiresAt != 0 || got.ProfileArn != "" {
		t.Fatalf("oauth fields should be empty: refresh=%q expiresAt=%d profileArn=%q", got.RefreshToken, got.ExpiresAt, got.ProfileArn)
	}
	if got.MachineId != config.MachineIdFromAPIKey("ksk_test_import") {
		t.Fatalf("machineId = %q", got.MachineId)
	}
	if strings.Contains(rec.Body.String(), "ksk_") {
		t.Fatalf("import response must not echo the key: %s", rec.Body.String())
	}
}

func TestApiImportCredentialsBareAPIKeyInAccessToken(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	modelCalls := stubImportNetwork(t)
	h := &Handler{pool: accountpool.GetPool()}

	//! A Kiro CLI export pasted into the generic token field, with no refresh token.
	rec := importCredentials(h, `{"accessToken":"ksk_pasted"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_pasted")
	accs := config.GetAccounts()
	if len(accs) != 1 || accs[0].KiroApiKey != "ksk_pasted" || accs[0].Region != "us-east-1" {
		t.Fatalf("expected one API key account in us-east-1, got %+v", accs)
	}
}

func TestApiImportCredentialsAPIKeyDuplicateRejected(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	modelCalls := stubImportNetwork(t)
	h := &Handler{pool: accountpool.GetPool()}

	body := `{"kiroApiKey":"ksk_dup_import","authMethod":"api_key"}`
	if rec := importCredentials(h, body); rec.Code != http.StatusOK {
		t.Fatalf("first import expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_dup_import")

	rec := importCredentials(h, body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	if n := len(config.GetAccounts()); n != 1 {
		t.Fatalf("expected 1 account after duplicate, got %d", n)
	}
}

func TestApiImportCredentialsAPIKeyRejectsInvalidRegion(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	stubImportNetwork(t)
	h := &Handler{pool: accountpool.GetPool()}

	//! The region becomes part of a hostname, so a host-like value must never be stored.
	rec := importCredentials(h, `{"kiroApiKey":"ksk_region","region":"evil.example.com/x"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if n := len(config.GetAccounts()); n != 0 {
		t.Fatalf("expected no account on invalid region, got %d", n)
	}
}

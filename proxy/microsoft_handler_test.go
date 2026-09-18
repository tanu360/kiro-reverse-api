package proxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	handlerMicrosoftTenantID = "11111111-2222-4333-8444-555555555555"
	handlerMicrosoftClientID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	handlerMicrosoftObjectID = "99999999-8888-4777-8666-555555555555"
)

type handlerMicrosoftRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn handlerMicrosoftRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestMicrosoftSSOHandlerTwoStageProfileSelectionPersistsOnlyOfferedProfile(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	accessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "enterprise@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})

	var discoveryRequests, tokenRequests int
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			switch {
			case request.Method == http.MethodGet &&
				request.URL.String() == issuerURL+"/.well-known/openid-configuration":
				discoveryRequests++
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"issuer":                 issuerURL,
					"authorization_endpoint": handlerMicrosoftAuthorizationEndpoint(),
					"token_endpoint":         tokenEndpoint,
				}), nil
			case request.Method == http.MethodPost && request.URL.String() == tokenEndpoint:
				tokenRequests++
				if err := request.ParseForm(); err != nil {
					return nil, fmt.Errorf("parse token form: %w", err)
				}
				if got := request.Form.Get("grant_type"); got != "authorization_code" {
					t.Errorf("grant_type = %q, want authorization_code", got)
				}
				if got := request.Form.Get("client_id"); got != handlerMicrosoftClientID {
					t.Errorf("client_id = %q, want %q", got, handlerMicrosoftClientID)
				}
				if got := request.Form.Get("code"); got != "provider-code" {
					t.Errorf("code = %q, want provider-code", got)
				}
				if got := request.Form.Get("redirect_uri"); got != "http://localhost:3128/oauth/callback" {
					t.Errorf("redirect_uri = %q", got)
				}
				if request.Form.Get("code_verifier") == "" {
					t.Error("token exchange omitted PKCE code_verifier")
				}
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"access_token":  accessToken,
					"refresh_token": "login-refresh-token",
					"expires_in":    3600,
					"token_type":    "Bearer",
				}), nil
			default:
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	const (
		usProfile = "arn:aws:codewhisperer:us-east-1:123456789012:profile/us-profile"
		euProfile = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu-profile"
	)
	var profileRegions []string
	restClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.Path != "/ListAvailableProfiles" {
				return nil, fmt.Errorf("unexpected Kiro REST request: %s %s", request.Method, request.URL)
			}
			switch request.URL.Hostname() {
			case "codewhisperer.us-east-1.amazonaws.com":
				profileRegions = append(profileRegions, "us-east-1")
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"profiles": []map[string]string{{
						"arn":         usProfile,
						"profileName": "US profile",
					}},
				}), nil
			case "q.eu-central-1.amazonaws.com":
				profileRegions = append(profileRegions, "eu-central-1")
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"profiles": []map[string]string{{
						"arn":         euProfile,
						"profileName": "EU profile",
					}},
				}), nil
			default:
				return nil, fmt.Errorf("unexpected Kiro REST host %q", request.URL.Hostname())
			}
		}),
	}
	previousRestClient := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(restClient)
	t.Cleanup(func() { kiroRestHttpStore.Store(previousRestClient) })

	startRecorder := httptest.NewRecorder()
	h.apiStartMicrosoftSSO(
		startRecorder,
		httptest.NewRequest(http.MethodPost, "/auth/microsoft-sso/start", strings.NewReader("{}")),
	)
	if startRecorder.Code != http.StatusOK {
		t.Fatalf("start status = %d, body=%s", startRecorder.Code, startRecorder.Body.String())
	}
	var startResponse struct {
		SessionID    string `json:"sessionId"`
		AuthorizeURL string `json:"authorizeUrl"`
		Stage        string `json:"stage"`
	}
	decodeHandlerMicrosoftJSON(t, startRecorder, &startResponse)
	if startResponse.SessionID == "" || startResponse.Stage != "kiro" {
		t.Fatalf("unexpected start response: %+v", startResponse)
	}
	t.Cleanup(func() { auth.CancelMicrosoftSSOLogin(startResponse.SessionID) })
	portalAuthorizeURL := mustHandlerMicrosoftURL(t, startResponse.AuthorizeURL)
	portalState := portalAuthorizeURL.Query().Get("state")
	if portalState == "" {
		t.Fatal("Kiro authorization URL omitted state")
	}

	portalCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/signin/callback",
		RawQuery: url.Values{
			"state":        {portalState},
			"login_option": {auth.MicrosoftSSOAuthMethod},
			"issuer_url":   {issuerURL},
			"client_id":    {handlerMicrosoftClientID},
			"scopes":       {scopes},
			"login_hint":   {"enterprise@example.com"},
		}.Encode(),
	}
	firstCompleteRecorder := callMicrosoftCompleteHandler(
		t, h, startResponse.SessionID, portalCallback.String(),
	)
	if firstCompleteRecorder.Code != http.StatusOK {
		t.Fatalf("first callback status = %d, body=%s", firstCompleteRecorder.Code, firstCompleteRecorder.Body.String())
	}
	var firstCompleteResponse struct {
		Success      bool   `json:"success"`
		Stage        string `json:"stage"`
		AuthorizeURL string `json:"authorizeUrl"`
	}
	decodeHandlerMicrosoftJSON(t, firstCompleteRecorder, &firstCompleteResponse)
	if !firstCompleteResponse.Success || firstCompleteResponse.Stage != "microsoft" {
		t.Fatalf("unexpected first callback response: %+v", firstCompleteResponse)
	}
	providerAuthorizeURL := mustHandlerMicrosoftURL(t, firstCompleteResponse.AuthorizeURL)
	if providerAuthorizeURL.String() == portalAuthorizeURL.String() {
		t.Fatal("first callback did not advance to the Microsoft authorization URL")
	}
	providerState := providerAuthorizeURL.Query().Get("state")
	if providerState == "" {
		t.Fatal("Microsoft authorization URL omitted state")
	}

	providerCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/oauth/callback",
		RawQuery: url.Values{
			"state": {providerState},
			"code":  {"provider-code"},
		}.Encode(),
	}
	secondCompleteRecorder := callMicrosoftCompleteHandler(
		t, h, startResponse.SessionID, providerCallback.String(),
	)
	if secondCompleteRecorder.Code != http.StatusOK {
		t.Fatalf("second callback status = %d, body=%s", secondCompleteRecorder.Code, secondCompleteRecorder.Body.String())
	}
	var profileResponse struct {
		Success     bool          `json:"success"`
		Stage       string        `json:"stage"`
		SelectionID string        `json:"selectionId"`
		Profiles    []KiroProfile `json:"profiles"`
	}
	decodeHandlerMicrosoftJSON(t, secondCompleteRecorder, &profileResponse)
	if !profileResponse.Success || profileResponse.Stage != "profile" || profileResponse.SelectionID == "" {
		t.Fatalf("unexpected profile response: %+v", profileResponse)
	}
	if len(profileResponse.Profiles) != 2 {
		t.Fatalf("profiles = %+v, want two offered profiles", profileResponse.Profiles)
	}
	if len(config.GetAccounts()) != 0 {
		t.Fatal("account was persisted before the required profile selection")
	}
	if pendingMicrosoftSelection(profileResponse.SelectionID) == nil {
		t.Fatal("profile selection was not retained by the handler")
	}

	const notOffered = "arn:aws:codewhisperer:us-east-1:123456789012:profile/not-offered"
	rejectedRecorder := callMicrosoftProfileSelectionHandler(
		t, h, profileResponse.SelectionID, notOffered,
	)
	if rejectedRecorder.Code != http.StatusBadRequest {
		t.Fatalf("unoffered profile status = %d, body=%s", rejectedRecorder.Code, rejectedRecorder.Body.String())
	}
	if len(config.GetAccounts()) != 0 {
		t.Fatal("unoffered profile selection persisted an account")
	}
	if pendingMicrosoftSelection(profileResponse.SelectionID) == nil {
		t.Fatal("invalid profile choice consumed the pending selection")
	}

	selectedRecorder := callMicrosoftProfileSelectionHandler(
		t, h, profileResponse.SelectionID, euProfile,
	)
	if selectedRecorder.Code != http.StatusOK {
		t.Fatalf("offered profile status = %d, body=%s", selectedRecorder.Code, selectedRecorder.Body.String())
	}
	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("accounts = %+v, want one persisted account", accounts)
	}
	got := accounts[0]
	if got.Region != "us-east-1" {
		t.Fatalf("auth Region changed to %q during profile selection", got.Region)
	}
	if got.ProfileArn != euProfile {
		t.Fatalf("ProfileArn = %q, want selected %q", got.ProfileArn, euProfile)
	}
	if got.AuthMethod != auth.MicrosoftSSOAuthMethod || got.Provider != auth.MicrosoftSSOProvider {
		t.Fatalf("unexpected external IdP identity: authMethod=%q provider=%q", got.AuthMethod, got.Provider)
	}
	if got.AccessToken != accessToken || got.RefreshToken != "login-refresh-token" {
		t.Fatalf("unexpected persisted tokens: access=%q refresh=%q", got.AccessToken, got.RefreshToken)
	}
	if got.ClientID != handlerMicrosoftClientID ||
		got.TokenEndpoint != tokenEndpoint ||
		got.IssuerURL != issuerURL ||
		got.Scopes != scopes {
		t.Fatalf("external IdP metadata was not preserved: %+v", got)
	}
	if got.Email != "enterprise@example.com" ||
		got.UserId != issuerURL+"."+handlerMicrosoftObjectID {
		t.Fatalf("unexpected persisted token identity: email=%q userId=%q", got.Email, got.UserId)
	}
	if pendingMicrosoftSelection(profileResponse.SelectionID) != nil {
		t.Fatal("completed profile selection was not consumed")
	}
	if discoveryRequests != 1 || tokenRequests != 1 {
		t.Fatalf("discovery/token calls = %d/%d, want 1/1", discoveryRequests, tokenRequests)
	}
	if strings.Join(profileRegions, ",") != "us-east-1,eu-central-1" {
		t.Fatalf("profile probe regions = %v, want auth region followed by EU fallback", profileRegions)
	}
}

func TestExternalIdpJSONImportRefreshesAndRoundTripsCompleteFields(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	refreshedAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":   issuerURL,
		"oid":   handlerMicrosoftObjectID,
		"email": "refreshed@example.com",
		"exp":   time.Now().Add(90 * time.Minute).Unix(),
	})
	const profileARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/imported-profile"

	var refreshRequests int
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.String() != tokenEndpoint {
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
			refreshRequests++
			if err := request.ParseForm(); err != nil {
				return nil, fmt.Errorf("parse refresh form: %w", err)
			}
			if got := request.Form.Get("grant_type"); got != "refresh_token" {
				t.Errorf("grant_type = %q, want refresh_token", got)
			}
			if got := request.Form.Get("refresh_token"); got != "import-refresh-token" {
				t.Errorf("refresh_token = %q, want import-refresh-token", got)
			}
			if got := request.Form.Get("scope"); got != scopes {
				t.Errorf("scope = %q, want %q", got, scopes)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"access_token":  refreshedAccessToken,
				"refresh_token": "rotated-refresh-token",
				"expires_in":    5400,
				"token_type":    "Bearer",
			}), nil
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	// Import verifies supplied profileArn against ListAvailableProfiles for
	// the refreshed external_idp token before persisting.
	previousRestClient := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(&http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.Path != "/ListAvailableProfiles" {
				return nil, fmt.Errorf("unexpected Kiro REST request: %s %s", request.Method, request.URL)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"profiles": []map[string]string{{
					"arn":         profileARN,
					"profileName": "Imported profile",
				}},
			}), nil
		}),
	})
	t.Cleanup(func() { kiroRestHttpStore.Store(previousRestClient) })

	importPayload := map[string]interface{}{
		"email":         "stale@example.com",
		"userId":        "stale-user-id",
		"nickname":      "Imported Microsoft",
		"profileArn":    profileARN,
		"accessToken":   "stale-access-token",
		"refreshToken":  "import-refresh-token",
		"clientId":      handlerMicrosoftClientID,
		"authMethod":    auth.MicrosoftSSOAuthMethod,
		"provider":      auth.MicrosoftSSOProvider,
		"region":        "ap-southeast-2",
		"tokenEndpoint": tokenEndpoint,
		"issuerUrl":     issuerURL,
		"scopes":        scopes,
	}
	importRecorder := callImportCredentialsHandler(t, h, importPayload)
	if importRecorder.Code != http.StatusOK {
		t.Fatalf("import status = %d, body=%s", importRecorder.Code, importRecorder.Body.String())
	}
	if refreshRequests != 1 {
		t.Fatalf("refresh requests = %d, want one live refresh", refreshRequests)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("accounts = %+v, want one imported account", accounts)
	}
	got := accounts[0]
	accountID := got.ID
	if got.Nickname != "Imported Microsoft" ||
		got.AuthMethod != auth.MicrosoftSSOAuthMethod ||
		got.Provider != auth.MicrosoftSSOProvider ||
		got.Region != "ap-southeast-2" {
		t.Fatalf("imported account metadata mismatch: %+v", got)
	}
	if got.AccessToken != refreshedAccessToken || got.RefreshToken != "rotated-refresh-token" {
		t.Fatalf("live refresh result was not persisted: access=%q refresh=%q", got.AccessToken, got.RefreshToken)
	}
	if got.Email != "refreshed@example.com" ||
		got.UserId != issuerURL+"."+handlerMicrosoftObjectID {
		t.Fatalf("refreshed token identity was not persisted: email=%q userId=%q", got.Email, got.UserId)
	}
	if got.ProfileArn != profileARN ||
		got.TokenEndpoint != tokenEndpoint ||
		got.IssuerURL != issuerURL ||
		got.Scopes != scopes {
		t.Fatalf("external IdP round-trip fields were not persisted: %+v", got)
	}
	if got.ExpiresAt < time.Now().Add(89*time.Minute).Unix() {
		t.Fatalf("ExpiresAt = %d, want live expires_in value", got.ExpiresAt)
	}

	fullRecorder := httptest.NewRecorder()
	h.apiGetAccountFull(
		fullRecorder,
		httptest.NewRequest(http.MethodGet, "/accounts/"+accountID+"/full", nil),
		accountID,
	)
	if fullRecorder.Code != http.StatusOK {
		t.Fatalf("full-account status = %d, body=%s", fullRecorder.Code, fullRecorder.Body.String())
	}
	var full map[string]interface{}
	decodeHandlerMicrosoftJSON(t, fullRecorder, &full)
	assertHandlerMicrosoftStringFields(t, full, map[string]string{
		"id":            accountID,
		"userId":        issuerURL + "." + handlerMicrosoftObjectID,
		"profileArn":    profileARN,
		"tokenEndpoint": tokenEndpoint,
		"issuerUrl":     issuerURL,
		"scopes":        scopes,
	})

	exportBody, err := json.Marshal(map[string]interface{}{"ids": []string{accountID}})
	if err != nil {
		t.Fatalf("marshal export body: %v", err)
	}
	exportRecorder := httptest.NewRecorder()
	h.apiExportAccounts(
		exportRecorder,
		httptest.NewRequest(http.MethodPost, "/export", strings.NewReader(string(exportBody))),
	)
	if exportRecorder.Code != http.StatusOK {
		t.Fatalf("export status = %d, body=%s", exportRecorder.Code, exportRecorder.Body.String())
	}
	var exported struct {
		Accounts []struct {
			ID          string `json:"id"`
			UserID      string `json:"userId"`
			ProfileARN  string `json:"profileArn"`
			Credentials struct {
				AccessToken   string `json:"accessToken"`
				RefreshToken  string `json:"refreshToken"`
				AuthMethod    string `json:"authMethod"`
				TokenEndpoint string `json:"tokenEndpoint"`
				IssuerURL     string `json:"issuerUrl"`
				Scopes        string `json:"scopes"`
			} `json:"credentials"`
		} `json:"accounts"`
	}
	decodeHandlerMicrosoftJSON(t, exportRecorder, &exported)
	if len(exported.Accounts) != 1 {
		t.Fatalf("exported accounts = %+v, want one", exported.Accounts)
	}
	exportedAccount := exported.Accounts[0]
	if exportedAccount.ID != accountID ||
		exportedAccount.UserID != issuerURL+"."+handlerMicrosoftObjectID ||
		exportedAccount.ProfileARN != profileARN {
		t.Fatalf("exported account identity mismatch: %+v", exportedAccount)
	}
	if exportedAccount.Credentials.AccessToken != refreshedAccessToken ||
		exportedAccount.Credentials.RefreshToken != "rotated-refresh-token" ||
		exportedAccount.Credentials.AuthMethod != auth.MicrosoftSSOAuthMethod ||
		exportedAccount.Credentials.TokenEndpoint != tokenEndpoint ||
		exportedAccount.Credentials.IssuerURL != issuerURL ||
		exportedAccount.Credentials.Scopes != scopes {
		t.Fatalf("exported credentials mismatch: %+v", exportedAccount.Credentials)
	}

	duplicateRecorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"refreshToken":  "import-refresh-token",
		"clientId":      handlerMicrosoftClientID,
		"authMethod":    auth.MicrosoftSSOAuthMethod,
		"provider":      auth.MicrosoftSSOProvider,
		"region":        "us-east-1",
		"tokenEndpoint": tokenEndpoint,
		"issuerUrl":     issuerURL,
		"scopes":        scopes,
	})
	// The Entra object ID only shows after a refresh, so the duplicate is
	// caught then, before anything is saved.
	if duplicateRecorder.Code != http.StatusConflict {
		t.Fatalf("duplicate Entra user import status = %d, want 409; body=%s",
			duplicateRecorder.Code, duplicateRecorder.Body.String())
	}
	if len(config.GetAccounts()) != 1 {
		t.Fatal("duplicate Entra user import persisted a second account")
	}
}

func newMicrosoftHandlerForTest(t *testing.T) *Handler {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	previousFlows := microsoftSSOFlows
	microsoftSSOFlows = newMicrosoftFlows()
	t.Cleanup(func() { microsoftSSOFlows = previousFlows })
	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p}
}

func pendingMicrosoftSelection(selectionID string) *microsoftSelection {
	microsoftSSOFlows.mu.Lock()
	defer microsoftSSOFlows.mu.Unlock()
	return microsoftSSOFlows.selections[selectionID]
}

func callMicrosoftCompleteHandler(t *testing.T, h *Handler, sessionID, callbackURL string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"sessionId":   sessionID,
		"callbackUrl": callbackURL,
	})
	if err != nil {
		t.Fatalf("marshal Microsoft completion body: %v", err)
	}
	recorder := httptest.NewRecorder()
	h.apiCompleteMicrosoftSSO(
		recorder,
		httptest.NewRequest(http.MethodPost, "/auth/microsoft-sso/complete", strings.NewReader(string(body))),
	)
	return recorder
}

func callMicrosoftProfileSelectionHandler(t *testing.T, h *Handler, selectionID, profileARN string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"selectionId": selectionID,
		"profileArn":  profileARN,
	})
	if err != nil {
		t.Fatalf("marshal Microsoft profile selection body: %v", err)
	}
	recorder := httptest.NewRecorder()
	h.apiSelectMicrosoftSSOProfile(
		recorder,
		httptest.NewRequest(http.MethodPost, "/auth/microsoft-sso/select-profile", strings.NewReader(string(body))),
	)
	return recorder
}

func callImportCredentialsHandler(t *testing.T, h *Handler, payload map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal credential import body: %v", err)
	}
	recorder := httptest.NewRecorder()
	h.apiImportCredentials(
		recorder,
		httptest.NewRequest(http.MethodPost, "/auth/credentials", strings.NewReader(string(body))),
	)
	return recorder
}

func decodeHandlerMicrosoftJSON(t *testing.T, recorder *httptest.ResponseRecorder, destination interface{}) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), destination); err != nil {
		t.Fatalf("decode JSON response %q: %v", recorder.Body.String(), err)
	}
}

func assertHandlerMicrosoftStringFields(t *testing.T, got map[string]interface{}, want map[string]string) {
	t.Helper()
	for field, expected := range want {
		if actual, _ := got[field].(string); actual != expected {
			t.Errorf("%s = %q, want %q", field, actual, expected)
		}
	}
}

func mustHandlerMicrosoftURL(t *testing.T, rawURL string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse URL %q: %v", rawURL, err)
	}
	return parsed
}

func handlerMicrosoftIssuerURL() string {
	return "https://login.microsoftonline.com/" + handlerMicrosoftTenantID + "/v2.0"
}

func handlerMicrosoftAuthorizationEndpoint() string {
	return "https://login.microsoftonline.com/" + handlerMicrosoftTenantID + "/oauth2/v2.0/authorize"
}

func handlerMicrosoftTokenEndpoint() string {
	return "https://login.microsoftonline.com/" + handlerMicrosoftTenantID + "/oauth2/v2.0/token"
}

func handlerMicrosoftScopes() string {
	return strings.Join([]string{
		"api://" + handlerMicrosoftClientID + "/codewhisperer:conversations",
		"api://" + handlerMicrosoftClientID + "/codewhisperer:completions",
		"offline_access",
	}, " ")
}

func handlerMicrosoftJWT(t *testing.T, claims map[string]interface{}) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("marshal JWT header: %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal JWT payload: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func handlerMicrosoftJSONResponse(request *http.Request, statusCode int, value interface{}) *http.Response {
	body, _ := json.Marshal(value)
	return &http.Response{
		StatusCode: statusCode,
		Status:     fmt.Sprintf("%d %s", statusCode, http.StatusText(statusCode)),
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body:    io.NopCloser(strings.NewReader(string(body))),
		Request: request,
	}
}

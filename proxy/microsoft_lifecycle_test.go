package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBareMicrosoftCredentialBlobIsDetectedAndImported(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	sourceAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "source@example.com",
		"exp":                time.Now().Add(30 * time.Minute).Unix(),
	})
	refreshedAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "bare-import@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})

	var refreshRequests int
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			refreshRequests++
			if request.Method != http.MethodPost || request.URL.String() != tokenEndpoint {
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
			if err := request.ParseForm(); err != nil {
				return nil, fmt.Errorf("parse refresh form: %w", err)
			}
			if got := request.Form.Get("grant_type"); got != "refresh_token" {
				t.Errorf("grant_type = %q, want refresh_token", got)
			}
			if got := request.Form.Get("refresh_token"); got != "bare-refresh-token" {
				t.Errorf("refresh_token = %q, want bare-refresh-token", got)
			}
			if got := request.Form.Get("client_id"); got != handlerMicrosoftClientID {
				t.Errorf("client_id = %q, want %q", got, handlerMicrosoftClientID)
			}
			if got := request.Form.Get("scope"); got != scopes {
				t.Errorf("scope = %q, want %q", got, scopes)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"access_token":  refreshedAccessToken,
				"refresh_token": "bare-rotated-refresh-token",
				"expires_in":    3600,
				"token_type":    "Bearer",
			}), nil
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	// Deliberately omit authMethod, provider, issuerUrl, tokenEndpoint and
	// userId. The allow-listed issuer hint carried by the supplied access JWT is
	// enough to classify the shape; the mandatory live refresh still validates
	// the credential against the tenant-bound Microsoft token endpoint.
	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"clientId":     handlerMicrosoftClientID,
		"accessToken":  sourceAccessToken,
		"refreshToken": "bare-refresh-token",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("bare Microsoft import status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if refreshRequests != 1 {
		t.Fatalf("refresh requests = %d, want one", refreshRequests)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("accounts = %+v, want one imported account", accounts)
	}
	got := accounts[0]
	if got.AuthMethod != auth.MicrosoftSSOAuthMethod || got.Provider != auth.MicrosoftSSOProvider {
		t.Fatalf("bare credential was not classified as Microsoft external_idp: authMethod=%q provider=%q",
			got.AuthMethod, got.Provider)
	}
	if got.TokenEndpoint != tokenEndpoint || got.IssuerURL != issuerURL || got.Scopes != scopes {
		t.Fatalf("derived external-IdP configuration mismatch: endpoint=%q issuer=%q scopes=%q",
			got.TokenEndpoint, got.IssuerURL, got.Scopes)
	}
	if got.AccessToken != refreshedAccessToken || got.RefreshToken != "bare-rotated-refresh-token" {
		t.Fatalf("live refresh result was not persisted: access=%q refresh=%q",
			got.AccessToken, got.RefreshToken)
	}
	if got.Email != "bare-import@example.com" ||
		got.UserId != issuerURL+"."+handlerMicrosoftObjectID {
		t.Fatalf("refreshed identity mismatch: email=%q userId=%q", got.Email, got.UserId)
	}
}

func TestMicrosoftSelectionCancelBlocksSave(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)
	profiles := []KiroProfile{{
		ARN:    "arn:aws:codewhisperer:us-east-1:123456789012:profile/pending",
		Name:   "Pending profile",
		Region: "us-east-1",
	}}
	flows := microsoftSSOFlows
	flows.mu.Lock()
	selectionID, err := flows.storeSelectionLocked("pending-session", config.Account{
		ID:           "pending-account",
		AccessToken:  "pending-access-token",
		RefreshToken: "pending-refresh-token",
		AuthMethod:   auth.MicrosoftSSOAuthMethod,
	}, profiles, time.Now())
	flows.mu.Unlock()
	if err != nil {
		t.Fatalf("storeSelectionLocked: %v", err)
	}

	// The browser only knows the selection ID at this point; that alone must
	// drop the credential and block the parent session from saving later.
	cancelRecorder := httptest.NewRecorder()
	h.apiCancelMicrosoftSSO(cancelRecorder, httptest.NewRequest(http.MethodPost, "/auth/microsoft-sso/cancel",
		strings.NewReader(fmt.Sprintf(`{"selectionId":%q}`, selectionID))))
	if cancelRecorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if pendingMicrosoftSelection(selectionID) != nil {
		t.Fatal("canceled selection still holds the credential")
	}
	flows.mu.Lock()
	canceled := flows.canceledLocked("pending-session", time.Now())
	addErr := flows.addAccountLocked("pending-session", config.Account{ID: "late"})
	flows.mu.Unlock()
	if !canceled {
		t.Fatal("canceling by selection ID did not mark the parent session canceled")
	}
	if !errors.Is(addErr, errMicrosoftSSOCanceled) {
		t.Fatalf("save after cancel returned %v, want errMicrosoftSSOCanceled", addErr)
	}

	selectRecorder := callMicrosoftProfileSelectionHandler(t, h, selectionID, profiles[0].ARN)
	if selectRecorder.Code != http.StatusBadRequest {
		t.Fatalf("select-after-cancel status = %d, want 400; body=%s", selectRecorder.Code, selectRecorder.Body.String())
	}
	if accounts := config.GetAccounts(); len(accounts) != 0 {
		t.Fatalf("select-after-cancel persisted accounts: %+v", accounts)
	}
}

func TestMicrosoftSelectionCapacityLimit(t *testing.T) {
	newMicrosoftHandlerForTest(t)
	flows := microsoftSSOFlows
	now := time.Now()
	flows.mu.Lock()
	defer flows.mu.Unlock()

	var first string
	for i := 0; i < microsoftMaxSelections; i++ {
		id, err := flows.storeSelectionLocked(fmt.Sprintf("session-%d", i), config.Account{}, nil, now)
		if err != nil {
			t.Fatalf("store %d/%d: %v", i+1, microsoftMaxSelections, err)
		}
		if first == "" {
			first = id
		}
	}
	if _, err := flows.storeSelectionLocked("over-capacity", config.Account{}, nil, now); err == nil {
		t.Fatalf("selection %d bypassed the cap", microsoftMaxSelections+1)
	}

	// Expired entries free their slot on the next store.
	flows.selections[first].expiresAt = now.Add(-time.Second)
	if _, err := flows.storeSelectionLocked("replacement", config.Account{}, nil, now); err != nil {
		t.Fatalf("store after one selection expired: %v", err)
	}
	if len(flows.selections) != microsoftMaxSelections {
		t.Fatalf("selections = %d, want %d", len(flows.selections), microsoftMaxSelections)
	}
}

func TestMicrosoftSSOCancelDuringProfileDiscoveryDoesNotPersist(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	accessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":                issuerURL,
		"oid":                handlerMicrosoftObjectID,
		"preferred_username": "canceled@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})
	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			switch {
			case request.Method == http.MethodGet &&
				request.URL.String() == issuerURL+"/.well-known/openid-configuration":
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"issuer":                 issuerURL,
					"authorization_endpoint": handlerMicrosoftAuthorizationEndpoint(),
					"token_endpoint":         handlerMicrosoftTokenEndpoint(),
				}), nil
			case request.Method == http.MethodPost &&
				request.URL.String() == handlerMicrosoftTokenEndpoint():
				return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
					"access_token":  accessToken,
					"refresh_token": "canceled-login-refresh-token",
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

	discoveryStarted := make(chan struct{}, 1)
	restClient := &http.Client{
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			select {
			case discoveryStarted <- struct{}{}:
			default:
			}
			<-request.Context().Done()
			return nil, request.Context().Err()
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
	}
	decodeHandlerMicrosoftJSON(t, startRecorder, &startResponse)
	t.Cleanup(func() { auth.CancelMicrosoftSSOLogin(startResponse.SessionID) })

	portalState := mustHandlerMicrosoftURL(t, startResponse.AuthorizeURL).Query().Get("state")
	portalCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/signin/callback",
		RawQuery: url.Values{
			"state":        {portalState},
			"login_option": {auth.MicrosoftSSOAuthMethod},
			"issuer_url":   {issuerURL},
			"client_id":    {handlerMicrosoftClientID},
			"scopes":       {handlerMicrosoftScopes()},
		}.Encode(),
	}
	firstCompleteRecorder := callMicrosoftCompleteHandler(
		t, h, startResponse.SessionID, portalCallback.String(),
	)
	if firstCompleteRecorder.Code != http.StatusOK {
		t.Fatalf("first callback status = %d, body=%s",
			firstCompleteRecorder.Code, firstCompleteRecorder.Body.String())
	}
	var firstCompleteResponse struct {
		AuthorizeURL string `json:"authorizeUrl"`
	}
	decodeHandlerMicrosoftJSON(t, firstCompleteRecorder, &firstCompleteResponse)
	providerState := mustHandlerMicrosoftURL(t, firstCompleteResponse.AuthorizeURL).Query().Get("state")
	providerCallback := url.URL{
		Scheme: "http",
		Host:   "localhost:3128",
		Path:   "/oauth/callback",
		RawQuery: url.Values{
			"state": {providerState},
			"code":  {"provider-code"},
		}.Encode(),
	}

	completeBody, err := json.Marshal(map[string]string{
		"sessionId":   startResponse.SessionID,
		"callbackUrl": providerCallback.String(),
	})
	if err != nil {
		t.Fatalf("marshal final callback: %v", err)
	}
	finalCompleteRecorder := httptest.NewRecorder()
	completeDone := make(chan struct{})
	go func() {
		h.apiCompleteMicrosoftSSO(
			finalCompleteRecorder,
			httptest.NewRequest(
				http.MethodPost,
				"/auth/microsoft-sso/complete",
				strings.NewReader(string(completeBody)),
			),
		)
		close(completeDone)
	}()

	select {
	case <-discoveryStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("profile discovery did not start")
	}

	cancelBody, err := json.Marshal(map[string]string{"sessionId": startResponse.SessionID})
	if err != nil {
		t.Fatalf("marshal cancel request: %v", err)
	}
	cancelRecorder := httptest.NewRecorder()
	h.apiCancelMicrosoftSSO(
		cancelRecorder,
		httptest.NewRequest(
			http.MethodPost,
			"/auth/microsoft-sso/cancel",
			strings.NewReader(string(cancelBody)),
		),
	)
	if cancelRecorder.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}

	select {
	case <-completeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("profile discovery did not stop after cancellation")
	}
	if finalCompleteRecorder.Code != http.StatusConflict {
		t.Fatalf("final completion status = %d, want 409 after cancellation; body=%s",
			finalCompleteRecorder.Code, finalCompleteRecorder.Body.String())
	}
	if accounts := config.GetAccounts(); len(accounts) != 0 {
		t.Fatalf("canceled login persisted accounts: %+v", accounts)
	}
	microsoftSSOFlows.mu.Lock()
	pendingSelections := len(microsoftSSOFlows.selections)
	microsoftSSOFlows.mu.Unlock()
	if pendingSelections != 0 {
		t.Fatalf("canceled login retained %d pending profile selections", pendingSelections)
	}
}

func TestExternalIdpImportRejectsUnofferedProfileArn(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	issuerURL := handlerMicrosoftIssuerURL()
	tokenEndpoint := handlerMicrosoftTokenEndpoint()
	scopes := handlerMicrosoftScopes()
	refreshedAccessToken := handlerMicrosoftJWT(t, map[string]interface{}{
		"iss":   issuerURL,
		"oid":   handlerMicrosoftObjectID,
		"email": "profile-check@example.com",
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	const offeredARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/offered"
	const unofferedARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/unoffered"

	authClient := &http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.String() != tokenEndpoint {
				return nil, fmt.Errorf("unexpected auth request: %s %s", request.Method, request.URL)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"access_token":  refreshedAccessToken,
				"refresh_token": "rotated-for-profile-check",
				"expires_in":    3600,
				"token_type":    "Bearer",
			}), nil
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	previousRestClient := kiroRestHttpStore.Load()
	kiroRestHttpStore.Store(&http.Client{
		Timeout: time.Second,
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.Path != "/ListAvailableProfiles" {
				return nil, fmt.Errorf("unexpected Kiro REST request: %s %s", request.Method, request.URL)
			}
			return handlerMicrosoftJSONResponse(request, http.StatusOK, map[string]interface{}{
				"profiles": []map[string]string{{
					"arn":         offeredARN,
					"profileName": "Offered",
				}},
			}), nil
		}),
	})
	t.Cleanup(func() { kiroRestHttpStore.Store(previousRestClient) })

	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"refreshToken":  "profile-check-refresh",
		"clientId":      handlerMicrosoftClientID,
		"authMethod":    auth.MicrosoftSSOAuthMethod,
		"tokenEndpoint": tokenEndpoint,
		"issuerUrl":     issuerURL,
		"scopes":        scopes,
		"profileArn":    unofferedARN,
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "not offered") {
		t.Fatalf("body = %s, want not-offered error", recorder.Body.String())
	}
	if accounts := config.GetAccounts(); len(accounts) != 0 {
		t.Fatalf("unoffered profileArn import persisted accounts: %+v", accounts)
	}
}

func TestExplicitIdcAuthMethodWinsOverTokenEndpointHint(t *testing.T) {
	h := newMicrosoftHandlerForTest(t)

	// If classification still forces external_idp from tokenEndpoint, validation
	// of the Microsoft endpoint will run and reject this IdC-shaped import before
	// any social/IdC refresh is attempted. Explicit idc must win.
	authClient := &http.Client{
		Transport: handlerMicrosoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if strings.Contains(request.URL.Host, "microsoftonline") {
				return nil, fmt.Errorf("should not reach Microsoft endpoint for explicit idc: %s", request.URL)
			}
			// IdC refresh path is free to fail; classification is what we care about.
			return nil, fmt.Errorf("idc refresh blocked in test")
		}),
	}
	previousAuthClient := auth.SetGlobalAuthClientForTest(authClient)
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(previousAuthClient) })

	recorder := callImportCredentialsHandler(t, h, map[string]interface{}{
		"refreshToken":  "idc-refresh-token",
		"clientId":      "idc-client",
		"clientSecret":  "idc-secret",
		"authMethod":    "idc",
		"region":        "us-east-1",
		"tokenEndpoint": "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/oauth2/v2.0/token",
		"issuerUrl":     "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0",
	})
	body := recorder.Body.String()
	// Must not be classified as external_idp (those fail earlier with Microsoft
	// client_id UUID / scope validation, or hit login.microsoftonline.com).
	if strings.Contains(body, "Microsoft client_id") ||
		strings.Contains(body, "external IdP") ||
		(strings.Contains(body, "scopes") && strings.Contains(body, "offline_access")) ||
		strings.Contains(body, "should not reach Microsoft endpoint") {
		t.Fatalf("explicit idc was classified as external_idp: %s", body)
	}
	if !strings.Contains(body, "Token refresh failed") {
		t.Fatalf("expected IdC refresh path error, got %s", body)
	}
}

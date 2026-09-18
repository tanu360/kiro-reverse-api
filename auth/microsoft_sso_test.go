package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testMicrosoftTenantID = "11111111-2222-4333-8444-555555555555"
	testMicrosoftClientID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
)

type microsoftRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn microsoftRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestStartMicrosoftSSOLoginBuildsManualPortalRequestAndCancel(t *testing.T) {
	resetMicrosoftSSOSessionsForTest(t)

	sessionID, authorizationURL, expiresIn, err := StartMicrosoftSSOLogin()
	if err != nil {
		t.Fatalf("StartMicrosoftSSOLogin() error = %v", err)
	}
	if sessionID == "" {
		t.Fatal("StartMicrosoftSSOLogin() returned an empty session ID")
	}
	if expiresIn != int(microsoftSSOSessionTTL.Seconds()) {
		t.Fatalf("expiresIn = %d, want %d", expiresIn, int(microsoftSSOSessionTTL.Seconds()))
	}

	parsed := mustParseMicrosoftURL(t, authorizationURL)
	if parsed.Scheme != "https" || parsed.Host != "app.kiro.dev" || parsed.Path != "/signin" {
		t.Fatalf("authorization URL = %q, want Kiro sign-in URL", authorizationURL)
	}
	query := parsed.Query()
	for _, key := range []string{"state", "code_challenge"} {
		if query.Get(key) == "" {
			t.Errorf("authorization URL is missing %s", key)
		}
	}
	if query.Get("code_challenge_method") != "S256" {
		t.Errorf("code_challenge_method = %q, want S256", query.Get("code_challenge_method"))
	}
	if query.Get("redirect_uri") != microsoftLoopbackBaseURL {
		t.Errorf("redirect_uri = %q, want %q", query.Get("redirect_uri"), microsoftLoopbackBaseURL)
	}
	if query.Get("redirect_from") != microsoftSSORedirectSource {
		t.Errorf("redirect_from = %q, want %q", query.Get("redirect_from"), microsoftSSORedirectSource)
	}

	session := mustMicrosoftSession(t, sessionID)
	if !constantTimeEqual(query.Get("state"), session.PortalState) {
		t.Error("portal state in the browser URL does not match the server-side session")
	}

	CancelMicrosoftSSOLogin(sessionID)
	if getMicrosoftSSOSession(sessionID) != nil {
		t.Fatal("CancelMicrosoftSSOLogin() did not remove the session")
	}
	if _, err := ContinueMicrosoftSSOLogin(sessionID, microsoftLoopbackBaseURL+microsoftPortalCallback); err == nil {
		t.Fatal("ContinueMicrosoftSSOLogin() succeeded after cancellation")
	}

	// Cancellation is intentionally idempotent for modal close/back handlers.
	CancelMicrosoftSSOLogin(sessionID)
	CancelMicrosoftSSOLogin("unknown-session")
}

func TestMicrosoftSSOTwoStageManualCallback(t *testing.T) {
	resetMicrosoftSSOSessionsForTest(t)

	issuer := testMicrosoftIssuer()
	authorizationEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/authorize"
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	scopes := testMicrosoftScopes()
	accessToken := microsoftTestJWT(t, map[string]any{
		"iss":                issuer,
		"preferred_username": "developer@example.com",
		"oid":                "99999999-8888-4777-8666-555555555555",
		"exp":                time.Now().Add(time.Hour).Unix(),
	})

	var providerQuery url.Values
	requestCount := 0
	client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestCount++
		switch {
		case request.Method == http.MethodGet:
			if got, want := request.URL.String(), issuer+"/.well-known/openid-configuration"; got != want {
				t.Fatalf("discovery URL = %q, want %q", got, want)
			}
			if request.Header.Get("Accept") != "application/json" {
				t.Errorf("discovery Accept header = %q", request.Header.Get("Accept"))
			}
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"issuer":                 issuer,
				"authorization_endpoint": authorizationEndpoint,
				"token_endpoint":         tokenEndpoint,
			}), nil
		case request.Method == http.MethodPost:
			if request.URL.String() != tokenEndpoint {
				t.Fatalf("token URL = %q, want %q", request.URL.String(), tokenEndpoint)
			}
			if contentType := request.Header.Get("Content-Type"); contentType != "application/x-www-form-urlencoded" {
				t.Errorf("token Content-Type = %q", contentType)
			}
			if err := request.ParseForm(); err != nil {
				t.Fatalf("parse token form: %v", err)
			}
			assertMicrosoftFormValue(t, request.PostForm, "client_id", testMicrosoftClientID)
			assertMicrosoftFormValue(t, request.PostForm, "grant_type", "authorization_code")
			assertMicrosoftFormValue(t, request.PostForm, "code", "provider-code")
			assertMicrosoftFormValue(t, request.PostForm, "redirect_uri", microsoftLoopbackBaseURL+microsoftOAuthCallback)
			assertMicrosoftFormValue(t, request.PostForm, "scope", scopes)
			verifier := request.PostForm.Get("code_verifier")
			if verifier == "" {
				t.Fatal("token request is missing code_verifier")
			}
			if providerQuery == nil {
				t.Fatal("token request happened before the provider authorization URL was inspected")
			}
			if got, want := pkceChallenge(verifier), providerQuery.Get("code_challenge"); got != want {
				t.Errorf("PKCE challenge = %q, want %q", got, want)
			}
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"access_token":  accessToken,
				"refresh_token": "rotating-refresh-token",
				"expires_in":    3600,
				"token_type":    "Bearer",
			}), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s %s", request.Method, request.URL)
		}
	})}
	restoreMicrosoftAuthClient(t, client)

	sessionID, _, _, err := StartMicrosoftSSOLogin()
	if err != nil {
		t.Fatalf("StartMicrosoftSSOLogin() error = %v", err)
	}
	session := mustMicrosoftSession(t, sessionID)
	session.ProxyURL = ""

	portalCallback := microsoftPortalCallbackURL(
		session.PortalState,
		issuer,
		testMicrosoftClientID,
		scopes,
		"developer@example.com",
		true,
	)
	progress, err := ContinueMicrosoftSSOLogin(sessionID, portalCallback)
	if err != nil {
		t.Fatalf("first ContinueMicrosoftSSOLogin() error = %v", err)
	}
	if progress == nil || progress.AuthorizationURL == "" || progress.Result != nil {
		t.Fatalf("first progress = %#v, want a provider authorization URL only", progress)
	}

	providerURL := mustParseMicrosoftURL(t, progress.AuthorizationURL)
	if got, want := providerURL.Scheme+"://"+providerURL.Host+providerURL.Path, authorizationEndpoint; got != want {
		t.Fatalf("provider authorization endpoint = %q, want %q", got, want)
	}
	providerQuery = providerURL.Query()
	assertMicrosoftQueryValue(t, providerQuery, "client_id", testMicrosoftClientID)
	assertMicrosoftQueryValue(t, providerQuery, "response_type", "code")
	assertMicrosoftQueryValue(t, providerQuery, "response_mode", "query")
	assertMicrosoftQueryValue(t, providerQuery, "redirect_uri", microsoftLoopbackBaseURL+microsoftOAuthCallback)
	assertMicrosoftQueryValue(t, providerQuery, "scope", scopes)
	assertMicrosoftQueryValue(t, providerQuery, "code_challenge_method", "S256")
	assertMicrosoftQueryValue(t, providerQuery, "login_hint", "developer@example.com")
	if providerQuery.Get("state") == "" || providerQuery.Get("code_challenge") == "" {
		t.Fatal("provider authorization URL is missing state or PKCE challenge")
	}

	beforeExchange := time.Now().Unix()
	providerCallback := microsoftProviderCallbackURL(providerQuery.Get("state"), "provider-code")
	completed, err := ContinueMicrosoftSSOLogin(sessionID, providerCallback)
	if err != nil {
		t.Fatalf("second ContinueMicrosoftSSOLogin() error = %v", err)
	}
	if completed == nil || completed.Result == nil || completed.AuthorizationURL != "" {
		t.Fatalf("completed progress = %#v, want a credential only", completed)
	}
	result := completed.Result
	if result.AccessToken != accessToken ||
		result.RefreshToken != "rotating-refresh-token" ||
		result.ClientID != testMicrosoftClientID ||
		result.TokenEndpoint != tokenEndpoint ||
		result.IssuerURL != issuer ||
		result.Scopes != scopes {
		t.Errorf("unexpected Microsoft SSO result: %#v", result)
	}
	if result.Email != "developer@example.com" {
		t.Errorf("result.Email = %q", result.Email)
	}
	if want := issuer + ".99999999-8888-4777-8666-555555555555"; result.UserID != want {
		t.Errorf("result.UserID = %q, want %q", result.UserID, want)
	}
	if result.ExpiresAt < beforeExchange+3599 || result.ExpiresAt > time.Now().Unix()+3601 {
		t.Errorf("result.ExpiresAt = %d, want approximately now + 3600", result.ExpiresAt)
	}
	if requestCount != 2 {
		t.Errorf("request count = %d, want discovery + token exchange", requestCount)
	}
	if getMicrosoftSSOSession(sessionID) != nil {
		t.Fatal("completed Microsoft SSO session was not removed")
	}
}

func TestMicrosoftSSOCallbackValidationCanBeRetried(t *testing.T) {
	resetMicrosoftSSOSessionsForTest(t)

	issuer := testMicrosoftIssuer()
	authorizationEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/authorize"
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	discoveryCalls := 0
	tokenCalls := 0
	client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.Method {
		case http.MethodGet:
			discoveryCalls++
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"issuer":                 issuer,
				"authorization_endpoint": authorizationEndpoint,
				"token_endpoint":         tokenEndpoint,
			}), nil
		case http.MethodPost:
			tokenCalls++
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"access_token":  "opaque-access-token",
				"refresh_token": "refresh-token",
				"expires_in":    900,
			}), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s %s", request.Method, request.URL)
		}
	})}
	restoreMicrosoftAuthClient(t, client)

	sessionID, _, _, err := StartMicrosoftSSOLogin()
	if err != nil {
		t.Fatalf("StartMicrosoftSSOLogin() error = %v", err)
	}
	session := mustMicrosoftSession(t, sessionID)
	session.ProxyURL = ""

	validWithState := microsoftPortalCallbackURL(
		session.PortalState,
		issuer,
		testMicrosoftClientID,
		testMicrosoftScopes(),
		"",
		true,
	)
	cases := []struct {
		name     string
		callback string
		contains string
	}{
		{
			name:     "foreign host",
			callback: strings.Replace(validWithState, "localhost:3128", "127.0.0.1:3128", 1),
			contains: "must be",
		},
		{
			name:     "wrong path",
			callback: strings.Replace(validWithState, microsoftPortalCallback, microsoftOAuthCallback, 1),
			contains: "must be",
		},
		{
			name:     "wrong state",
			callback: strings.Replace(validWithState, url.QueryEscape(session.PortalState), "wrong-state", 1),
			contains: "state",
		},
		{
			name:     "duplicate client id",
			callback: validWithState + "&client_id=" + url.QueryEscape(testMicrosoftClientID),
			contains: "duplicate client_id",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := ContinueMicrosoftSSOLogin(sessionID, testCase.callback); err == nil ||
				!strings.Contains(err.Error(), testCase.contains) {
				t.Fatalf("ContinueMicrosoftSSOLogin() error = %v, want substring %q", err, testCase.contains)
			}
			current := getMicrosoftSSOSession(sessionID)
			if current == nil || current.stage != microsoftSSOWaitingForPortal {
				t.Fatalf("invalid callback consumed or advanced the portal session: %#v", current)
			}
		})
	}
	if discoveryCalls != 0 {
		t.Fatalf("invalid portal callbacks made %d discovery requests", discoveryCalls)
	}

	// Compatibility with the real Kiro descriptor: state is optional on this
	// first leg, while all other descriptor fields remain strictly validated.
	validWithoutState := microsoftPortalCallbackURL(
		"",
		issuer,
		testMicrosoftClientID,
		testMicrosoftScopes(),
		"",
		false,
	)
	progress, err := ContinueMicrosoftSSOLogin(sessionID, validWithoutState)
	if err != nil {
		t.Fatalf("valid state-less portal callback error = %v", err)
	}
	providerState := mustParseMicrosoftURL(t, progress.AuthorizationURL).Query().Get("state")
	if providerState == "" {
		t.Fatal("provider URL is missing state")
	}

	invalidProviderCallbacks := []string{
		"http://localhost:3128/signin/callback?state=" + url.QueryEscape(providerState) + "&code=x",
		microsoftProviderCallbackURL("wrong-state", "x"),
	}
	for _, callback := range invalidProviderCallbacks {
		if _, err := ContinueMicrosoftSSOLogin(sessionID, callback); err == nil {
			t.Fatalf("invalid provider callback %q succeeded", callback)
		}
		current := getMicrosoftSSOSession(sessionID)
		if current == nil || current.stage != microsoftSSOWaitingForProvider {
			t.Fatalf("invalid provider callback consumed or regressed the session: %#v", current)
		}
	}

	completed, err := ContinueMicrosoftSSOLogin(sessionID, microsoftProviderCallbackURL(providerState, "retry-code"))
	if err != nil {
		t.Fatalf("provider callback retry error = %v", err)
	}
	if completed == nil || completed.Result == nil {
		t.Fatalf("provider callback retry result = %#v", completed)
	}
	if discoveryCalls != 1 || tokenCalls != 1 {
		t.Errorf("network calls = discovery %d, token %d; want 1 each", discoveryCalls, tokenCalls)
	}
}

func TestMicrosoftSSOSessionExpiry(t *testing.T) {
	resetMicrosoftSSOSessionsForTest(t)

	sessionID, _, _, err := StartMicrosoftSSOLogin()
	if err != nil {
		t.Fatalf("StartMicrosoftSSOLogin() error = %v", err)
	}
	session := mustMicrosoftSession(t, sessionID)
	session.ExpiresAt = time.Now().Add(-time.Second)

	if _, err := ContinueMicrosoftSSOLogin(sessionID, "anything"); err == nil ||
		!strings.Contains(err.Error(), "expired") {
		t.Fatalf("ContinueMicrosoftSSOLogin() error = %v, want expiry error", err)
	}
	if getMicrosoftSSOSession(sessionID) != nil {
		t.Fatal("expired session was not removed")
	}
}

func TestCancelMicrosoftSSODoesNotWaitForInFlightDiscovery(t *testing.T) {
	resetMicrosoftSSOSessionsForTest(t)

	issuer := testMicrosoftIssuer()
	discoveryEntered := make(chan struct{})
	releaseDiscovery := make(chan struct{})
	client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(discoveryEntered)
		<-releaseDiscovery
		return microsoftJSONResponse(request, http.StatusOK, map[string]any{
			"issuer":                 issuer,
			"authorization_endpoint": issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/authorize",
			"token_endpoint":         issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		}), nil
	})}
	restoreMicrosoftAuthClient(t, client)

	sessionID, _, _, err := StartMicrosoftSSOLogin()
	if err != nil {
		t.Fatalf("StartMicrosoftSSOLogin() error = %v", err)
	}
	session := mustMicrosoftSession(t, sessionID)
	session.ProxyURL = ""
	callback := microsoftPortalCallbackURL(
		session.PortalState,
		issuer,
		testMicrosoftClientID,
		testMicrosoftScopes(),
		"",
		true,
	)

	continueResult := make(chan error, 1)
	go func() {
		_, err := ContinueMicrosoftSSOLogin(sessionID, callback)
		continueResult <- err
	}()
	<-discoveryEntered

	cancelReturned := make(chan struct{})
	go func() {
		CancelMicrosoftSSOLogin(sessionID)
		close(cancelReturned)
	}()
	select {
	case <-cancelReturned:
	case <-time.After(time.Second):
		t.Fatal("CancelMicrosoftSSOLogin blocked on in-flight discovery")
	}
	close(releaseDiscovery)

	if err := <-continueResult; err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("in-flight continuation error = %v, want cancellation", err)
	}
	if getMicrosoftSSOSession(sessionID) != nil {
		t.Fatal("canceled in-flight session remained registered")
	}
}

func TestParseMicrosoftLoopbackCallbackRejectsForeignURLs(t *testing.T) {
	valid := microsoftLoopbackBaseURL + microsoftOAuthCallback + "?state=state&code=code"
	if _, err := parseMicrosoftLoopbackCallback(valid, microsoftOAuthCallback); err != nil {
		t.Fatalf("valid callback rejected: %v", err)
	}

	for _, testCase := range []struct {
		name string
		raw  string
	}{
		{name: "empty", raw: ""},
		{name: "https", raw: "https://localhost:3128/oauth/callback"},
		{name: "foreign host", raw: "http://127.0.0.1:3128/oauth/callback"},
		{name: "suffix host", raw: "http://localhost.evil:3128/oauth/callback"},
		{name: "missing port", raw: "http://localhost/oauth/callback"},
		{name: "wrong port", raw: "http://localhost:8080/oauth/callback"},
		{name: "userinfo", raw: "http://user@localhost:3128/oauth/callback"},
		{name: "wrong path", raw: "http://localhost:3128/signin/callback"},
		{name: "path case", raw: "http://localhost:3128/OAuth/callback"},
		{name: "fragment", raw: "http://localhost:3128/oauth/callback#state=x"},
		{name: "relative", raw: "/oauth/callback?code=x"},
		{name: "too long", raw: "http://localhost:3128/oauth/callback?" + strings.Repeat("x", microsoftSSOMaxCallbackLen)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := parseMicrosoftLoopbackCallback(testCase.raw, microsoftOAuthCallback); err == nil {
				t.Fatalf("parseMicrosoftLoopbackCallback(%q) succeeded", testCase.raw)
			}
		})
	}
}

func TestDiscoverMicrosoftOIDCRejectsMismatchedIssuerAndRedirect(t *testing.T) {
	issuer := testMicrosoftIssuer()
	authorizationEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/authorize"
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"

	t.Run("mismatched issuer", func(t *testing.T) {
		client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"issuer":                 "https://login.microsoftonline.com/66666666-7777-4888-8999-000000000000/v2.0",
				"authorization_endpoint": authorizationEndpoint,
				"token_endpoint":         tokenEndpoint,
			}), nil
		})}
		if _, _, err := discoverMicrosoftOIDC(client, issuer); err == nil ||
			!strings.Contains(err.Error(), "issuer does not match") {
			t.Fatalf("discoverMicrosoftOIDC() error = %v, want issuer mismatch", err)
		}
	})

	t.Run("redirect is not followed", func(t *testing.T) {
		requests := 0
		client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			if requests > 1 {
				t.Fatal("discovery redirect was followed")
			}
			response := microsoftTextResponse(request, http.StatusFound, "")
			response.Header.Set("Location", issuerBase(issuer)+"/redirected")
			return response, nil
		})}
		if _, _, err := discoverMicrosoftOIDC(client, issuer); err == nil ||
			!strings.Contains(err.Error(), "HTTP 302") {
			t.Fatalf("discoverMicrosoftOIDC() error = %v, want HTTP 302", err)
		}
		if requests != 1 {
			t.Fatalf("discovery request count = %d, want 1", requests)
		}
	})

	t.Run("cross tenant endpoint", func(t *testing.T) {
		client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return microsoftJSONResponse(request, http.StatusOK, map[string]any{
				"issuer":                 issuer,
				"authorization_endpoint": issuerBase(issuer) + "/66666666-7777-4888-8999-000000000000/oauth2/v2.0/authorize",
				"token_endpoint":         tokenEndpoint,
			}), nil
		})}
		if _, _, err := discoverMicrosoftOIDC(client, issuer); err == nil ||
			!strings.Contains(err.Error(), "issuer tenant") {
			t.Fatalf("discoverMicrosoftOIDC() error = %v, want tenant mismatch", err)
		}
	})
}

func TestPostExternalIdpTokenStrictResponseValidation(t *testing.T) {
	issuer := testMicrosoftIssuer()
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	testCases := []struct {
		name       string
		statusCode int
		body       string
		contains   string
	}{
		{
			name:       "malformed JSON",
			statusCode: http.StatusOK,
			body:       "{",
			contains:   "parse external IdP token response",
		},
		{
			name:       "wrong expires type",
			statusCode: http.StatusOK,
			body:       `{"access_token":"access","expires_in":"3600"}`,
			contains:   "parse external IdP token response",
		},
		{
			name:       "missing access token",
			statusCode: http.StatusOK,
			body:       `{"expires_in":3600}`,
			contains:   "missing access_token",
		},
		{
			name:       "zero expiry",
			statusCode: http.StatusOK,
			body:       `{"access_token":"access","expires_in":0}`,
			contains:   "invalid expires_in",
		},
		{
			name:       "negative expiry",
			statusCode: http.StatusOK,
			body:       `{"access_token":"access","expires_in":-1}`,
			contains:   "invalid expires_in",
		},
		{
			name:       "OAuth error",
			statusCode: http.StatusBadRequest,
			body:       `{"error":"invalid_grant","error_description":"expired code"}`,
			contains:   "HTTP 400: invalid_grant: expired code",
		},
		{
			name:       "oversized response",
			statusCode: http.StatusOK,
			body:       strings.Repeat("x", microsoftSSOMaxResponse+1),
			contains:   "response exceeds",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				return microsoftTextResponse(request, testCase.statusCode, testCase.body), nil
			})}
			_, err := postExternalIdpToken(context.Background(), client, tokenEndpoint, issuer, url.Values{"grant_type": {"test"}})
			if err == nil || !strings.Contains(err.Error(), testCase.contains) {
				t.Fatalf("postExternalIdpToken() error = %v, want substring %q", err, testCase.contains)
			}
		})
	}
}

func TestExchangeMicrosoftAuthorizationCodeRequiresRefreshToken(t *testing.T) {
	issuer := testMicrosoftIssuer()
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return microsoftJSONResponse(request, http.StatusOK, map[string]any{
			"access_token": "access",
			"expires_in":   3600,
		}), nil
	})}
	leg := &microsoftProviderLeg{
		CodeVerifier:  "verifier",
		IssuerURL:     issuer,
		TokenEndpoint: tokenEndpoint,
		ClientID:      testMicrosoftClientID,
		Scopes:        testMicrosoftScopes(),
	}
	if _, err := exchangeMicrosoftAuthorizationCode(client, leg, "code"); err == nil ||
		!strings.Contains(err.Error(), "did not return a refresh token") {
		t.Fatalf("exchangeMicrosoftAuthorizationCode() error = %v", err)
	}
}

func TestRefreshExternalIdpTokenRotatesAndPreservesRefreshToken(t *testing.T) {
	issuer := testMicrosoftIssuer()
	tokenEndpoint := issuerBase(issuer) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	responses := []map[string]any{
		{
			"access_token":  "access-one",
			"refresh_token": "refresh-two",
			"expires_in":    1200,
		},
		{
			"access_token": "access-two",
			"expires_in":   1800,
		},
	}
	requestNumber := 0
	client := &http.Client{Transport: microsoftRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if err := request.ParseForm(); err != nil {
			t.Fatalf("parse refresh form: %v", err)
		}
		assertMicrosoftFormValue(t, request.PostForm, "grant_type", "refresh_token")
		assertMicrosoftFormValue(t, request.PostForm, "client_id", testMicrosoftClientID)
		assertMicrosoftFormValue(t, request.PostForm, "scope", testMicrosoftScopes())
		if requestNumber >= len(responses) {
			return nil, fmt.Errorf("unexpected extra refresh request")
		}
		response := microsoftJSONResponse(request, http.StatusOK, responses[requestNumber])
		requestNumber++
		return response, nil
	})}

	beforeFirst := time.Now().Unix()
	access, refresh, expiresAt, region, err := refreshExternalIdpToken(
		context.Background(),
		"refresh-one",
		testMicrosoftClientID,
		tokenEndpoint,
		issuer,
		testMicrosoftScopes(),
		client,
	)
	if err != nil {
		t.Fatalf("first refreshExternalIdpToken() error = %v", err)
	}
	if access != "access-one" || refresh != "refresh-two" || region != "" {
		t.Errorf("first refresh = access %q, refresh %q, region %q", access, refresh, region)
	}
	if expiresAt < beforeFirst+1199 || expiresAt > time.Now().Unix()+1201 {
		t.Errorf("first expiry = %d, want approximately now + 1200", expiresAt)
	}

	if requestNumber != 1 {
		t.Fatalf("request number after first refresh = %d, want 1", requestNumber)
	}
	beforeSecond := time.Now().Unix()
	access, refresh, expiresAt, region, err = refreshExternalIdpToken(
		context.Background(),
		"refresh-two",
		testMicrosoftClientID,
		tokenEndpoint,
		issuer,
		testMicrosoftScopes(),
		client,
	)
	if err != nil {
		t.Fatalf("second refreshExternalIdpToken() error = %v", err)
	}
	if access != "access-two" || refresh != "refresh-two" || region != "" {
		t.Errorf("second refresh = access %q, refresh %q, region %q", access, refresh, region)
	}
	if expiresAt < beforeSecond+1799 || expiresAt > time.Now().Unix()+1801 {
		t.Errorf("second expiry = %d, want approximately now + 1800", expiresAt)
	}
}

func TestValidateExternalIdpEndpoint(t *testing.T) {
	accepted := []string{
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.microsoftonline.us/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.partner.microsoftonline.cn/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://LOGIN.MICROSOFTONLINE.COM:443/" + testMicrosoftTenantID + "/v2.0",
	}
	for _, endpoint := range accepted {
		if err := ValidateExternalIdpEndpoint(endpoint); err != nil {
			t.Errorf("ValidateExternalIdpEndpoint(%q) error = %v", endpoint, err)
		}
	}

	rejected := []string{
		"http://login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.microsoftonline.com.evil.example/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://127.0.0.1/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://user:password@login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.microsoftonline.com:444/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token#fragment",
		"//login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"not a URL",
	}
	for _, endpoint := range rejected {
		if err := ValidateExternalIdpEndpoint(endpoint); err == nil {
			t.Errorf("ValidateExternalIdpEndpoint(%q) succeeded", endpoint)
		}
	}
}

func TestExternalIdpConfigurationFromTokenEndpoint(t *testing.T) {
	tokenEndpoint := issuerBase(testMicrosoftIssuer()) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	normalizedToken, issuer, scopes := ExternalIdpConfigurationFromTokenEndpoint(tokenEndpoint, testMicrosoftClientID)
	if normalizedToken != tokenEndpoint {
		t.Fatalf("normalized token endpoint = %q, want %q", normalizedToken, tokenEndpoint)
	}
	if issuer != testMicrosoftIssuer() {
		t.Fatalf("issuer = %q, want %q", issuer, testMicrosoftIssuer())
	}
	if scopes == "" || !strings.Contains(scopes, "offline_access") {
		t.Fatalf("scopes = %q, want offline_access", scopes)
	}

	for _, invalid := range []string{
		"https://login.microsoftonline.com/common/oauth2/v2.0/token",
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/oauth2/v1.0/token",
		"https://example.com/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
	} {
		token, derivedIssuer, derivedScopes := ExternalIdpConfigurationFromTokenEndpoint(invalid, testMicrosoftClientID)
		if token != "" || derivedIssuer != "" || derivedScopes != "" {
			t.Errorf("invalid endpoint %q derived %q, %q, %q", invalid, token, derivedIssuer, derivedScopes)
		}
	}
}

func TestParseMicrosoftIssuerAndDiscoveredEndpointValidation(t *testing.T) {
	issuerURL := testMicrosoftIssuer()
	issuer, tenant, err := parseMicrosoftIssuer(issuerURL)
	if err != nil {
		t.Fatalf("parseMicrosoftIssuer() error = %v", err)
	}
	if tenant != testMicrosoftTenantID {
		t.Errorf("tenant = %q, want %q", tenant, testMicrosoftTenantID)
	}
	validTokenEndpoint := issuerBase(issuerURL) + "/" + testMicrosoftTenantID + "/oauth2/v2.0/token"
	if err := validateMicrosoftDiscoveredEndpoint(validTokenEndpoint, issuer, tenant, "/oauth2/v2.0/token"); err != nil {
		t.Fatalf("valid discovered endpoint rejected: %v", err)
	}

	for _, raw := range []string{
		"https://login.microsoftonline.com/common/v2.0",
		"https://login.microsoftonline.com/" + testMicrosoftTenantID,
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/v1.0",
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/v2.0/extra",
		"https://login.microsoftonline.com/" + testMicrosoftTenantID + "/v2.0?query=x",
	} {
		if _, _, err := parseMicrosoftIssuer(raw); err == nil {
			t.Errorf("parseMicrosoftIssuer(%q) succeeded", raw)
		}
	}

	rejectedEndpoints := []string{
		"https://login.microsoftonline.us/" + testMicrosoftTenantID + "/oauth2/v2.0/token",
		"https://login.microsoftonline.com/66666666-7777-4888-8999-000000000000/oauth2/v2.0/token",
		validTokenEndpoint + "?query=x",
		validTokenEndpoint + "/extra",
	}
	for _, endpoint := range rejectedEndpoints {
		if err := validateMicrosoftDiscoveredEndpoint(endpoint, issuer, tenant, "/oauth2/v2.0/token"); err == nil {
			t.Errorf("validateMicrosoftDiscoveredEndpoint(%q) succeeded", endpoint)
		}
	}
}

func resetMicrosoftSSOSessionsForTest(t *testing.T) {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("initialize test config: %v", err)
	}
	clearSessions := func() {
		microsoftSSOSessionsMu.Lock()
		for id, session := range microsoftSSOSessions {
			delete(microsoftSSOSessions, id)
			if session.timer != nil {
				session.timer.Stop()
			}
		}
		microsoftSSOSessionsMu.Unlock()
	}
	clearSessions()
	t.Cleanup(clearSessions)
}

func restoreMicrosoftAuthClient(t *testing.T, client *http.Client) {
	t.Helper()
	previous := SetGlobalAuthClientForTest(client)
	t.Cleanup(func() {
		SetGlobalAuthClientForTest(previous)
	})
}

func mustMicrosoftSession(t *testing.T, sessionID string) *microsoftSSOSession {
	t.Helper()
	session := getMicrosoftSSOSession(sessionID)
	if session == nil {
		t.Fatalf("Microsoft SSO session %q was not found", sessionID)
	}
	return session
}

func testMicrosoftIssuer() string {
	return "https://login.microsoftonline.com/" + testMicrosoftTenantID + "/v2.0"
}

func issuerBase(issuer string) string {
	parsed, _ := url.Parse(issuer)
	return parsed.Scheme + "://" + parsed.Host
}

func testMicrosoftScopes() string {
	return strings.Join([]string{
		"openid",
		"profile",
		"email",
		"offline_access",
		"api://" + testMicrosoftClientID + "/codewhisperer:conversations",
		"api://" + testMicrosoftClientID + "/codewhisperer:completions",
	}, " ")
}

func microsoftPortalCallbackURL(state, issuer, clientID, scopes, loginHint string, includeState bool) string {
	query := url.Values{}
	query.Set("login_option", MicrosoftSSOAuthMethod)
	query.Set("issuer_url", issuer)
	query.Set("client_id", clientID)
	query.Set("scopes", scopes)
	if includeState {
		query.Set("state", state)
	}
	if loginHint != "" {
		query.Set("login_hint", loginHint)
	}
	return microsoftLoopbackBaseURL + microsoftPortalCallback + "?" + query.Encode()
}

func microsoftProviderCallbackURL(state, code string) string {
	query := url.Values{}
	query.Set("state", state)
	query.Set("code", code)
	return microsoftLoopbackBaseURL + microsoftOAuthCallback + "?" + query.Encode()
}

func microsoftTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal JWT claims: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func microsoftJSONResponse(request *http.Request, statusCode int, value any) *http.Response {
	body, _ := json.Marshal(value)
	response := microsoftTextResponse(request, statusCode, string(body))
	response.Header.Set("Content-Type", "application/json")
	return response
}

func microsoftTextResponse(request *http.Request, statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}

func mustParseMicrosoftURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse URL %q: %v", raw, err)
	}
	return parsed
}

func assertMicrosoftFormValue(t *testing.T, form url.Values, key, want string) {
	t.Helper()
	if got := form.Get(key); got != want {
		t.Errorf("form %s = %q, want %q", key, got, want)
	}
}

func assertMicrosoftQueryValue(t *testing.T, query url.Values, key, want string) {
	t.Helper()
	if got := query.Get(key); got != want {
		t.Errorf("query %s = %q, want %q", key, got, want)
	}
}

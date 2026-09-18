package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/auth"
	"kiro-proxy/config"
)

func TestStoredRefreshSerializesStaleSnapshots(t *testing.T) {
	newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected model call") })
	account := config.Account{ID: "refresh", Enabled: true, AuthMethod: "idc", AccessToken: "old", RefreshToken: "old-refresh", ClientID: "client", ClientSecret: "secret", ExpiresAt: 1}
	if err := config.AddAccount(account); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		_, _ = w.Write([]byte(`{"accessToken":"new","refreshToken":"new-refresh","expiresIn":3600}`))
	}))
	defer server.Close()
	oldURL := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return server.URL })
	defer auth.SetOIDCTokenURLForTest(oldURL)
	oldClient := auth.SetGlobalAuthClientForTest(server.Client())
	defer auth.SetGlobalAuthClientForTest(oldClient)
	first, second := account, account
	done := make(chan error, 2)
	go func() { done <- refreshStoredAccount(context.Background(), &first, true) }()
	<-entered
	go func() { done <- refreshStoredAccount(context.Background(), &second, true) }()
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 || first.RefreshToken != "new-refresh" || second.RefreshToken != "new-refresh" {
		t.Fatalf("calls=%d first=%q second=%q", calls.Load(), first.RefreshToken, second.RefreshToken)
	}
	if err := config.DeleteAccount(account.ID); err != nil {
		t.Fatal(err)
	}
	if err := refreshStoredAccount(context.Background(), &first, true); err == nil {
		t.Fatal("deleted account refreshed")
	}
	if calls.Load() != 1 {
		t.Fatal("deleted account reached upstream")
	}
}

func TestRefreshLockWaitCanBeCanceled(t *testing.T) {
	unlock, err := lockAccountRefresh(context.Background(), "held")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if release, err := lockAccountRefresh(ctx, "held"); !errors.Is(err, context.Canceled) {
		if release != nil {
			release()
		}
		t.Fatalf("lock error = %v", err)
	}
}

func TestAccountRetryWaitCanBeCanceled(t *testing.T) {
	rp := newRequestRetryPlan()
	rp.backoff.BaseDelay = time.Hour
	rp.backoff.MaxDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { rp.waitBeforeRetry(ctx, 1); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled retry kept sleeping")
	}
}

func TestCanceledProfileLookupDoesNotReachUpstream(t *testing.T) {
	newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected model call") })
	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		t.Error("canceled profile lookup reached network")
		return jsonResponse(500, "{}"), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := resolveProfileArnContext(ctx, &config.Account{AccessToken: "token"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}

// Entra rotates the refresh token on every use. Two requests that both hold
// the pre-rotation snapshot must spend it once; the second adopts the result.
func TestStoredRefreshSpendsRotatingExternalIdpTokenOnce(t *testing.T) {
	newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected model call") })
	const tenant, client = "a1111111-b222-4ccc-8ddd-e55555555555", "f1111111-a222-4bbb-8ccc-d55555555555"
	tokenEndpoint := "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token"
	account := config.Account{
		ID: "entra-refresh", Enabled: true, AccessToken: "access-0", RefreshToken: "refresh-1", ExpiresAt: 1,
		ClientID: client, AuthMethod: auth.MicrosoftSSOAuthMethod, Provider: auth.MicrosoftSSOProvider, Region: "us-east-1",
		TokenEndpoint: tokenEndpoint,
		IssuerURL:     "https://login.microsoftonline.com/" + tenant + "/v2.0",
		Scopes:        "api://" + client + "/codewhisperer:conversations api://" + client + "/codewhisperer:completions offline_access",
	}
	if err := config.AddAccount(account); err != nil {
		t.Fatal(err)
	}

	var spent []string
	var mu sync.Mutex
	entered, release := make(chan struct{}), make(chan struct{})
	oldClient := auth.SetGlobalAuthClientForTest(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != tokenEndpoint {
			return nil, fmt.Errorf("unexpected request %s", r.URL)
		}
		if err := r.ParseForm(); err != nil {
			return nil, err
		}
		mu.Lock()
		spent = append(spent, r.Form.Get("refresh_token"))
		first := len(spent) == 1
		mu.Unlock()
		if first {
			close(entered)
			<-release
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"access-1","refresh_token":"refresh-2","expires_in":3600,"token_type":"Bearer"}`)),
			Request:    r,
		}, nil
	})})
	defer auth.SetGlobalAuthClientForTest(oldClient)

	first, second := account, account
	done := make(chan error, 2)
	go func() { done <- refreshStoredAccount(context.Background(), &first, true) }()
	<-entered
	go func() { done <- refreshStoredAccount(context.Background(), &second, true) }()
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if strings.Join(spent, ",") != "refresh-1" {
		t.Fatalf("refresh tokens sent = %v, want refresh-1 once", spent)
	}
	if first.RefreshToken != "refresh-2" || second.RefreshToken != "refresh-2" {
		t.Fatalf("callers hold %q and %q, want refresh-2", first.RefreshToken, second.RefreshToken)
	}
	var stored *config.Account
	for _, a := range config.GetAccounts() {
		if a.ID == account.ID {
			stored = &a
		}
	}
	if stored == nil || stored.RefreshToken != "refresh-2" || stored.AccessToken != "access-1" {
		t.Fatalf("stored account = %+v, want rotated tokens", stored)
	}
}

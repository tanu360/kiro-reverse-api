package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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

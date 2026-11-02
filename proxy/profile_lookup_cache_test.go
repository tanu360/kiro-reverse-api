package proxy

import (
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

const profileRequestBodyInvalid = `{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`

func stubProfileRefreshServer(t *testing.T, calls *int32) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accessToken":"rotated-access","refreshToken":"rotated-refresh","expiresIn":3600}`))
	}))
	t.Cleanup(server.Close)
	oldTokenURL := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return server.URL })
	t.Cleanup(func() { auth.SetOIDCTokenURLForTest(oldTokenURL) })
	oldClient := auth.SetGlobalAuthClientForTest(server.Client())
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(oldClient) })
}

func TestResolveProfileArnCachesNonTransientLookupFailure(t *testing.T) {
	clearProfileArnResolutionCooldowns()
	t.Cleanup(clearProfileArnResolutionCooldowns)

	var lookups int32
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		atomic.AddInt32(&lookups, 1)
		return jsonResponse(http.StatusBadRequest, profileRequestBodyInvalid), nil
	})

	account := &config.Account{ID: "negative-cache-1", Email: "user@example.com", AccessToken: "token", AuthMethod: "social", Provider: "Google"}
	for i := 0; i < 5; i++ {
		if _, err := ResolveProfileArn(account); err == nil {
			t.Fatalf("call %d: expected lookup failure", i)
		}
	}
	if got := atomic.LoadInt32(&lookups); got != 2 {
		t.Fatalf("expected one probe per region and cached failures afterwards, got %d lookups", got)
	}

	other := &config.Account{ID: "negative-cache-2", Email: "other@example.com", AccessToken: "token", AuthMethod: "social", Provider: "Google"}
	_, _ = ResolveProfileArn(other)
	if got := atomic.LoadInt32(&lookups); got != 4 {
		t.Fatalf("a cached failure must stay per account, got %d lookups", got)
	}
}

func TestResolveProfileArnRefreshFallbackRunsOncePerSuppressionWindow(t *testing.T) {
	cases := []struct {
		name       string
		provider   string
		status     int
		body       string
		wantLookup int32
	}{
		{name: "builder id unsupported", provider: "BuilderId", status: http.StatusForbidden, body: builderIDUnsupportedBody, wantLookup: 1},
		{name: "rejected lookup", provider: "Enterprise", status: http.StatusBadRequest, body: profileRequestBodyInvalid, wantLookup: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearProfileArnResolutionCooldowns()
			t.Cleanup(clearProfileArnResolutionCooldowns)
			if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatalf("init config: %v", err)
			}
			stored := config.Account{
				ID:           "fallback-" + tc.provider,
				Email:        "user@example.com",
				AccessToken:  "token",
				RefreshToken: "refresh-token",
				ClientID:     "client-id",
				ClientSecret: "client-secret",
				AuthMethod:   "idc",
				Provider:     tc.provider,
				Region:       "us-east-1",
				ExpiresAt:    time.Now().Add(time.Hour).Unix(),
				Enabled:      true,
			}
			if err := config.AddAccount(stored); err != nil {
				t.Fatalf("add account: %v", err)
			}

			var lookups, refreshes int32
			stubRestTransport(t, func(*http.Request) (*http.Response, error) {
				atomic.AddInt32(&lookups, 1)
				return jsonResponse(tc.status, tc.body), nil
			})
			stubProfileRefreshServer(t, &refreshes)

			account := stored
			for i := 0; i < 5; i++ {
				if _, err := ResolveProfileArn(&account); err == nil {
					t.Fatalf("call %d: expected no profile", i)
				}
			}
			if got := atomic.LoadInt32(&refreshes); got != 1 {
				t.Fatalf("expected one forced refresh per suppression window, got %d", got)
			}
			if got := atomic.LoadInt32(&lookups); got != tc.wantLookup {
				t.Fatalf("expected %d profile lookups, got %d", tc.wantLookup, got)
			}
		})
	}
}

func TestListAvailableModelsFollowsNextToken(t *testing.T) {
	var pages []string
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/ListAvailableModels" {
			t.Fatalf("unexpected path %s", req.URL.Path)
		}
		token := req.URL.Query().Get("nextToken")
		pages = append(pages, token)
		switch token {
		case "":
			return jsonResponse(http.StatusOK, `{"models":[{"modelId":"model-a"}],"nextToken":"page-2"}`), nil
		case "page-2":
			return jsonResponse(http.StatusOK, `{"models":[{"modelId":"model-b"}]}`), nil
		}
		t.Fatalf("unexpected nextToken %q", token)
		return nil, nil
	})

	models, err := ListAvailableModels(&config.Account{
		AccessToken: "token",
		ProfileArn:  "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
	})
	if err != nil {
		t.Fatalf("ListAvailableModels: %v", err)
	}
	if len(pages) != 2 || len(models) != 2 || models[0].ModelId != "model-a" || models[1].ModelId != "model-b" {
		t.Fatalf("expected both pages, got pages=%q models=%+v", pages, models)
	}
}

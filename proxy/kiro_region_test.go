package proxy

import (
	"context"
	"encoding/json"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const builderIDUnsupportedBody = `{"message":"AWS Builder ID is not supported for this operation.","reason":null}`

func clearProfileArnResolutionCooldowns() {
	profileArnResolutionCooldowns.Range(func(key, _ interface{}) bool {
		profileArnResolutionCooldowns.Delete(key)
		return true
	})
}

func stubRestTransport(t *testing.T, fn roundTripFunc) {
	t.Helper()
	kiroRestHttpStore.Store(&http.Client{Transport: fn})
	t.Cleanup(func() { InitKiroHttpClient("") })
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestParseKiroProfileArnStrictly(t *testing.T) {
	valid := "arn:aws:codewhisperer:eu-central-1:123456789012:profile/Profile_01"
	canonical, region, ok := parseKiroProfileArn(" " + valid + " ")
	if !ok || canonical != valid || region != "eu-central-1" {
		t.Fatalf("expected valid ARN, got canonical=%q region=%q ok=%v", canonical, region, ok)
	}
	for _, candidate := range []string{
		"arn:aws:codewhisperer:profile/test",
		"arn:aws:s3:eu-central-1:123456789012:profile/test",
		"arn:aws:codewhisperer:eu-central-1.evil:123456789012:profile/test",
		"arn:aws:codewhisperer:eu-central-1:not-an-account:profile/test",
		"arn:aws:codewhisperer:eu-central-1:123456789012:project/test",
		"arn:aws:codewhisperer:eu-central-1:123456789012:profile/test/child",
	} {
		if _, _, ok := parseKiroProfileArn(candidate); ok {
			t.Errorf("expected invalid ARN to be rejected: %q", candidate)
		}
	}
}

func TestRegionalizeURLFollowsProfileRegion(t *testing.T) {
	euArn := "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test"
	usArn := "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"
	cases := []struct {
		name    string
		account *config.Account
		payload string
		rawURL  string
		want    string
	}{
		{
			name:    "us-east-1 profile keeps default host",
			account: &config.Account{Region: "ap-southeast-1", ProfileArn: usArn},
			rawURL:  "https://q.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR",
			want:    "https://q.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR",
		},
		{
			name:    "eu profile moves q host",
			account: &config.Account{ProfileArn: euArn},
			rawURL:  "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
			want:    "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
		},
		{
			name:    "codewhisperer host maps to regional q host",
			account: &config.Account{Region: "ap-southeast-1"},
			payload: euArn,
			rawURL:  "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
			want:    "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
		},
		{
			name:    "auth region alone never moves the data plane",
			account: &config.Account{AuthMethod: "idc", Region: "ap-southeast-2"},
			rawURL:  "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
			want:    "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		},
		{
			name:    "malformed ARN falls back to default host",
			account: &config.Account{ProfileArn: "arn:aws:codewhisperer:evil.example.com:123456789012:profile/x"},
			rawURL:  "https://q.us-east-1.amazonaws.com/mcp",
			want:    "https://q.us-east-1.amazonaws.com/mcp",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := regionalizeURLForProfile(tc.rawURL, tc.account, tc.payload); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWebSearchMCPHostUsesProfileRegionNotAuthRegion(t *testing.T) {
	account := &config.Account{Region: "ap-southeast-2"}
	if got := webSearchMCPHost(account); got != "https://q.us-east-1.amazonaws.com" {
		t.Fatalf("auth region must not pick the MCP host, got %q", got)
	}
	account.ProfileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test"
	if got := webSearchMCPHost(account); got != "https://q.eu-central-1.amazonaws.com" {
		t.Fatalf("expected profile region MCP host, got %q", got)
	}
}

func TestKiroProfileRegionCandidates(t *testing.T) {
	want := []string{"us-east-1", "eu-central-1"}
	for _, account := range []*config.Account{
		nil,
		{AuthMethod: "idc", Region: "ap-southeast-2"},
		{Region: "evil.amazonaws.com"},
	} {
		if got := kiroProfileRegionCandidates(account); !reflect.DeepEqual(got, want) {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
	withArn := &config.Account{ProfileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test"}
	if got := kiroProfileRegionCandidates(withArn); !reflect.DeepEqual(got, []string{"eu-central-1", "us-east-1"}) {
		t.Fatalf("expected profile region first, got %v", got)
	}
}

func TestResolveProfileArnFallsBackToSecondRegion(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	var hosts []string
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		hosts = append(hosts, req.URL.Host)
		if req.URL.Host == "q.eu-central-1.amazonaws.com" {
			return jsonResponse(http.StatusOK, `{"profiles":[{"arn":"arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu"}]}`), nil
		}
		return jsonResponse(http.StatusOK, `{"profiles":[]}`), nil
	})

	account := &config.Account{ID: "acct-eu", Email: "eu@example.com", AccessToken: "token", Region: "us-east-1"}
	got, err := ResolveProfileArn(account)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu" {
		t.Fatalf("expected eu profile, got %q", got)
	}
	if !reflect.DeepEqual(hosts, []string{"codewhisperer.us-east-1.amazonaws.com", "q.eu-central-1.amazonaws.com"}) {
		t.Fatalf("expected us-east-1 then eu-central-1 probes, got %v", hosts)
	}
	if account.Region != "us-east-1" {
		t.Fatalf("profile resolution must not change the auth region, got %q", account.Region)
	}
}

func TestListAvailableProfilesFollowsNextToken(t *testing.T) {
	var pages int32
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		var body map[string]interface{}
		_ = json.NewDecoder(req.Body).Decode(&body)
		if atomic.AddInt32(&pages, 1) == 1 {
			if _, ok := body["nextToken"]; ok {
				t.Fatalf("first page must not send nextToken")
			}
			return jsonResponse(http.StatusOK, `{"profiles":[{"arn":"not-an-arn"}],"nextToken":"page-2"}`), nil
		}
		if body["nextToken"] != "page-2" {
			t.Fatalf("expected nextToken page-2, got %v", body["nextToken"])
		}
		return jsonResponse(http.StatusOK, `{"profiles":[{"arn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/p2"}]}`), nil
	})

	got, err := listAvailableProfiles(context.Background(), &config.Account{AccessToken: "token"}, "us-east-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "arn:aws:codewhisperer:us-east-1:123456789012:profile/p2" || atomic.LoadInt32(&pages) != 2 {
		t.Fatalf("expected second-page ARN after 2 pages, got %q after %d", got, pages)
	}
}

func TestResolveProfileArnSuppressesBuilderIDUnsupportedLookup(t *testing.T) {
	clearProfileArnResolutionCooldowns()
	t.Cleanup(clearProfileArnResolutionCooldowns)

	var calls int32
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		atomic.AddInt32(&calls, 1)
		return jsonResponse(http.StatusForbidden, builderIDUnsupportedBody), nil
	})

	account := &config.Account{ID: "builder-1", Email: "builder@example.com", AccessToken: "token", Provider: "BuilderId"}
	if _, err := ResolveProfileArn(account); !isProfileArnResolutionSoftError(err) {
		t.Fatalf("expected Builder ID unsupported error, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected one lookup and no second-region probe, got %d", got)
	}
	if _, err := ResolveProfileArn(account); !isProfileArnResolutionSoftError(err) {
		t.Fatalf("expected suppressed lookup error, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected no repeated lookup during cooldown, got %d", got)
	}
}

func TestResolveProfileArnKeepsRefreshFallbackForBuilderID(t *testing.T) {
	clearProfileArnResolutionCooldowns()
	t.Cleanup(clearProfileArnResolutionCooldowns)
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	stubRestTransport(t, func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusForbidden, builderIDUnsupportedBody), nil
	})

	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600,"profileArn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/from-refresh"}`))
	}))
	t.Cleanup(authServer.Close)
	oldTokenURL := auth.GetOIDCTokenURLForTest()
	auth.SetOIDCTokenURLForTest(func(string) string { return authServer.URL })
	t.Cleanup(func() { auth.SetOIDCTokenURLForTest(oldTokenURL) })
	oldAuthClient := auth.SetGlobalAuthClientForTest(authServer.Client())
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(oldAuthClient) })

	account := &config.Account{
		ID:           "builder-refresh-1",
		Email:        "builder@example.com",
		AccessToken:  "token",
		RefreshToken: "refresh-token",
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		AuthMethod:   "idc",
		Provider:     "BuilderId",
		Region:       "us-east-1",
	}
	got, err := ResolveProfileArn(account)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "arn:aws:codewhisperer:us-east-1:123456789012:profile/from-refresh" {
		t.Fatalf("expected refresh fallback ARN, got %q", got)
	}
	if isProfileArnResolutionSuppressed(account) {
		t.Fatalf("a refresh fallback success must not suppress future lookups")
	}
}

func TestRefreshAccountInfoDoesNotBanWhenProfileLookupFails(t *testing.T) {
	for name, lookup := range map[string]*http.Response{
		"builder id unsupported": jsonResponse(http.StatusForbidden, builderIDUnsupportedBody),
		"generic 403":            jsonResponse(http.StatusForbidden, `{"message":"forbidden"}`),
	} {
		t.Run(name, func(t *testing.T) {
			clearProfileArnResolutionCooldowns()
			t.Cleanup(clearProfileArnResolutionCooldowns)
			if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatalf("init config: %v", err)
			}
			account := config.Account{ID: "acct-" + strings.ReplaceAll(name, " ", "-"), Email: "user@example.com", AccessToken: "token", Provider: "BuilderId", Enabled: true}
			if err := config.AddAccount(account); err != nil {
				t.Fatalf("add account: %v", err)
			}

			var usageCalls int32
			body, _ := io.ReadAll(lookup.Body)
			stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
				switch req.URL.Path {
				case "/ListAvailableProfiles":
					return jsonResponse(lookup.StatusCode, string(body)), nil
				case "/getUsageLimits":
					atomic.AddInt32(&usageCalls, 1)
					if strings.Contains(req.URL.RawQuery, "profileArn=") {
						t.Fatalf("expected usage refresh without profileArn, got %q", req.URL.RawQuery)
					}
					return jsonResponse(http.StatusOK, `{}`), nil
				}
				t.Fatalf("unexpected path %s", req.URL.Path)
				return nil, nil
			})

			requestAccount := account
			if _, err := RefreshAccountInfo(&requestAccount); err != nil {
				t.Fatalf("expected refresh to continue without profile ARN, got %v", err)
			}
			if atomic.LoadInt32(&usageCalls) != 1 {
				t.Fatalf("expected one usage request, got %d", usageCalls)
			}
			stored := config.GetAccounts()[0]
			if !stored.Enabled || stored.BanStatus != "" {
				t.Fatalf("profile lookup failure must not ban the account: enabled=%v banStatus=%q", stored.Enabled, stored.BanStatus)
			}
		})
	}
}

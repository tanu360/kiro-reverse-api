package proxy

import (
	"errors"
	"kiro-proxy/config"
	"net/http"
	"testing"

	accountpool "kiro-proxy/pool"
)

func TestRegionOverrideMismatch(t *testing.T) {
	initUpstreamTest(t)
	usSocial := &config.Account{AuthMethod: "social", Region: "us-east-1", ProfileArn: upstreamTestUSArn}
	euIdC := &config.Account{AuthMethod: "idc", Region: "eu-central-1", ProfileArn: upstreamTestEUArn}
	builderID := &config.Account{AuthMethod: "builder-id"}
	euAPIKey := &config.Account{AuthMethod: config.AuthMethodAPIKey, KiroApiKey: "k", Region: "eu-central-1"}

	tests := []struct {
		name     string
		upstream config.UpstreamConfig
		account  *config.Account
		want     bool
	}{
		{"no override", config.UpstreamConfig{}, euIdC, false},
		{"apiRegion matches the profile", config.UpstreamConfig{APIRegion: "eu-central-1"}, euIdC, false},
		{"apiRegion differs from the profile", config.UpstreamConfig{APIRegion: "us-east-1"}, euIdC, true},
		{"apiRegion differs from a us profile", config.UpstreamConfig{APIRegion: "eu-central-1"}, usSocial, true},
		{"Builder ID without ARN is us-east-1", config.UpstreamConfig{APIRegion: "us-east-1"}, builderID, false},
		{"apiRegion differs from an API key region", config.UpstreamConfig{APIRegion: "us-east-1"}, euAPIKey, true},
		{"apiDomain alone is no mismatch", config.UpstreamConfig{APIDomain: config.APIDomainKiro}, euIdC, false},
		{"authRegion matches the account", config.UpstreamConfig{AuthRegion: "eu-central-1"}, euIdC, false},
		{"authRegion differs for IdC", config.UpstreamConfig{AuthRegion: "eu-west-1"}, euIdC, true},
		{"authRegion differs for Builder ID's default region", config.UpstreamConfig{AuthRegion: "eu-west-1"}, builderID, true},
		{"authRegion ignores social refresh", config.UpstreamConfig{AuthRegion: "eu-west-1"}, usSocial, false},
		{"authRegion ignores API keys", config.UpstreamConfig{AuthRegion: "us-east-1"}, euAPIKey, false},
		{"nil account", config.UpstreamConfig{APIRegion: "us-east-1"}, nil, false},
	}
	for _, tc := range tests {
		setUpstreamForTest(t, tc.upstream)
		if got := regionOverrideMismatch(tc.account); got != tc.want {
			t.Errorf("%s: regionOverrideMismatch = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// addFailoverAccount stores account and returns a Handler over a freshly loaded pool.
func addFailoverAccount(t *testing.T, account config.Account) *Handler {
	t.Helper()
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	return &Handler{pool: p}
}

func storedFailoverAccount(t *testing.T, id string) config.Account {
	t.Helper()
	for _, a := range config.GetAccounts() {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("account %s not stored", id)
	return config.Account{}
}

func TestAuthFailureUnderMismatchedOverrideDoesNotBan(t *testing.T) {
	const invalidToken = `HTTP 403 from Kiro IDE: {"message":"Invalid token"}`
	tests := []struct {
		name     string
		upstream config.UpstreamConfig
		account  config.Account
		err      string
		banned   bool
	}{
		{
			name:     "apiRegion sends an EU account to us-east-1",
			upstream: config.UpstreamConfig{APIRegion: "us-east-1"},
			account:  config.Account{AuthMethod: "idc", Region: "eu-central-1", ProfileArn: upstreamTestEUArn},
			err:      invalidToken,
		},
		{
			name:     "authRegion refreshes a Builder ID account in the wrong region",
			upstream: config.UpstreamConfig{AuthRegion: "eu-west-1"},
			account:  config.Account{AuthMethod: "builder-id", Region: "us-east-1"},
			err:      `token refresh failed: HTTP 400: {"error":"invalid_grant"}`,
		},
		{
			name:     "a matching override still bans a dead token",
			upstream: config.UpstreamConfig{APIRegion: "eu-central-1"},
			account:  config.Account{AuthMethod: "idc", Region: "eu-central-1", ProfileArn: upstreamTestEUArn},
			err:      invalidToken,
			banned:   true,
		},
		{
			name:    "no override still bans a dead token",
			account: config.Account{AuthMethod: "social", ProfileArn: upstreamTestUSArn},
			err:     invalidToken,
			banned:  true,
		},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			initUpstreamTest(t)
			setUpstreamForTest(t, tc.upstream)
			account := tc.account
			account.ID = "acct-override-" + string(rune('a'+i))
			account.Email = account.ID + "@example.com"
			account.Enabled = true
			h := addFailoverAccount(t, account)

			h.handleAccountFailure(&account, errors.New(tc.err))

			stored := storedFailoverAccount(t, account.ID)
			if tc.banned {
				if stored.Enabled || stored.BanStatus != "BANNED" {
					t.Fatalf("expected a ban, got enabled=%v banStatus=%q", stored.Enabled, stored.BanStatus)
				}
				return
			}
			if !stored.Enabled || stored.BanStatus != "" {
				t.Fatalf("a mismatched override must not ban: enabled=%v banStatus=%q reason=%q", stored.Enabled, stored.BanStatus, stored.BanReason)
			}
			//! Clearing the override leaves the account usable without a manual re-enable.
			setUpstreamForTest(t, config.UpstreamConfig{})
			if regionOverrideMismatch(&stored) {
				t.Fatalf("no mismatch expected once the override is cleared")
			}
		})
	}
}

func TestRefreshAccountInfoUnderMismatchedAPIRegionDoesNotBan(t *testing.T) {
	for _, tc := range []struct {
		name     string
		upstream config.UpstreamConfig
		wantHost string
		banned   bool
	}{
		{"mismatched apiRegion", config.UpstreamConfig{APIRegion: "us-east-1"}, "codewhisperer.us-east-1.amazonaws.com", false},
		{"no override", config.UpstreamConfig{}, "q.eu-central-1.amazonaws.com", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			initUpstreamTest(t)
			setUpstreamForTest(t, tc.upstream)
			account := config.Account{
				ID: "acct-usage-eu", Email: "eu@example.com", AuthMethod: "idc", Region: "eu-central-1",
				ProfileArn: upstreamTestEUArn, AccessToken: "token", Enabled: true,
			}
			if err := config.AddAccount(account); err != nil {
				t.Fatalf("add account: %v", err)
			}
			var hosts []string
			stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
				hosts = append(hosts, req.URL.Host)
				return jsonResponse(http.StatusForbidden, `{"message":"Invalid token"}`), nil
			})

			if _, err := RefreshAccountInfo(&account); err == nil {
				t.Fatal("expected the 403 to surface as an error")
			}
			if len(hosts) != 1 || hosts[0] != tc.wantHost {
				t.Fatalf("usage hosts = %v, want [%s]", hosts, tc.wantHost)
			}
			stored := storedFailoverAccount(t, account.ID)
			if tc.banned != (!stored.Enabled && stored.BanStatus == "BANNED") {
				t.Fatalf("banned = %v, want %v (enabled=%v banStatus=%q)", !stored.Enabled, tc.banned, stored.Enabled, stored.BanStatus)
			}
		})
	}
}

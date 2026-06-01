package proxy

import (
	"io"
	"kiro-proxy/config"
	"math"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveProfileArnReturnsCachedValueWithoutRequest(t *testing.T) {
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Fatal("unexpected HTTP request for cached profile ARN")
			return nil, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	account := &config.Account{ProfileArn: " arn:aws:codewhisperer:profile/test "}
	got, err := ResolveProfileArn(account)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "arn:aws:codewhisperer:profile/test" {
		t.Fatalf("expected trimmed cached ARN, got %q", got)
	}
}

func TestResolveProfileArnFetchesAndCachesProfile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "kiro.db")
	if err := config.Init(configPath); err != nil {
		t.Fatalf("init config: %v", err)
	}
	account := config.Account{
		ID:           "acct-1",
		Email:        "user@example.com",
		AccessToken:  "access-token",
		Region:       "us-east-1",
		UsageCurrent: 7,
	}
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("add account: %v", err)
	}

	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Method != http.MethodPost {
				t.Fatalf("expected POST, got %s", req.Method)
			}
			if req.URL.Path != "/ListAvailableProfiles" {
				t.Fatalf("expected ListAvailableProfiles path, got %s", req.URL.Path)
			}
			if got := req.Header.Get("Content-Type"); got != "application/json" {
				t.Fatalf("expected JSON content type, got %q", got)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"profiles":[{"arn":" arn:aws:codewhisperer:profile/fetched "}]} `)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	requestAccount := account
	requestAccount.UsageCurrent = 0
	got, err := ResolveProfileArn(&requestAccount)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "arn:aws:codewhisperer:profile/fetched" {
		t.Fatalf("expected fetched ARN, got %q", got)
	}
	if requestAccount.ProfileArn != got {
		t.Fatalf("expected account to be updated with fetched ARN, got %q", requestAccount.ProfileArn)
	}

	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("expected one persisted account, got %d", len(accounts))
	}
	if accounts[0].ProfileArn != got {
		t.Fatalf("expected persisted account profile ARN %q, got %q", got, accounts[0].ProfileArn)
	}
	if accounts[0].UsageCurrent != 7 {
		t.Fatalf("expected profile cache update to preserve usage fields, got usageCurrent=%v", accounts[0].UsageCurrent)
	}
}

func TestRefreshAccountInfoUsesPrecisionUsageFields(t *testing.T) {
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != "/getUsageLimits" {
				t.Fatalf("expected getUsageLimits path, got %s", req.URL.Path)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body: io.NopCloser(strings.NewReader(`{
					"usageBreakdownList": [
						{
							"resourceType": "CREDIT",
							"currentUsage": 2,
							"currentUsageWithPrecision": 2.91,
							"usageLimit": 10000,
							"usageLimitWithPrecision": 10000,
							"freeTrialInfo": {
								"currentUsage": 1,
								"currentUsageWithPrecision": 1.25,
								"usageLimit": 10,
								"usageLimitWithPrecision": 10.5,
								"freeTrialStatus": "ACTIVE"
							}
						}
					],
					"subscriptionInfo": {"subscriptionTitle": "KIRO POWER"}
				}`)),
				Header: make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	info, err := RefreshAccountInfo(&config.Account{AccessToken: "token"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if diff := math.Abs(info.UsageCurrent - 2.91); diff > 0.000001 {
		t.Fatalf("expected precise usage 2.91, got %v", info.UsageCurrent)
	}
	if diff := math.Abs(info.UsagePercent - 0.000291); diff > 0.000001 {
		t.Fatalf("expected precise usage percent, got %v", info.UsagePercent)
	}
	if diff := math.Abs(info.TrialUsageCurrent - 1.25); diff > 0.000001 {
		t.Fatalf("expected precise trial usage 1.25, got %v", info.TrialUsageCurrent)
	}
	if diff := math.Abs(info.TrialUsageLimit - 10.5); diff > 0.000001 {
		t.Fatalf("expected precise trial limit 10.5, got %v", info.TrialUsageLimit)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

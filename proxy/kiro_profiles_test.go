package proxy

import (
	"context"
	"io"
	"kiro-proxy/auth"
	"kiro-proxy/config"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestListKiroProfilesFollowsNextTokenPagination(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	var pages []string
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != "/ListAvailableProfiles" {
				t.Fatalf("unexpected path %s", req.URL.Path)
			}
			body, _ := io.ReadAll(req.Body)
			pages = append(pages, string(body))
			if strings.Contains(string(body), `"nextToken":"page-2"`) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(`{
						"profiles":[{"arn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/two","profileName":"Two"}]
					}`)),
				}, nil
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{
					"profiles":[{"arn":"arn:aws:codewhisperer:us-east-1:123456789012:profile/one","profileName":"One"}],
					"nextToken":"page-2"
				}`)),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	profiles, err := listKiroProfiles(context.Background(), &config.Account{
		AccessToken: "token",
		AuthMethod:  "external_idp",
		Region:      "us-east-1",
	}, "us-east-1", false)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(pages) != 2 {
		t.Fatalf("pages = %d (%v), want 2", len(pages), pages)
	}
	if len(profiles) != 2 || profiles[0].ARN == "" || profiles[1].ARN == "" {
		t.Fatalf("profiles = %+v, want two ARNs across pages", profiles)
	}
	if !strings.Contains(pages[0], `"maxResults":50`) {
		t.Fatalf("first page body = %s, want maxResults 50", pages[0])
	}
}

func TestParseKiroProfileARNStrictly(t *testing.T) {
	valid := "arn:aws:codewhisperer:eu-central-1:123456789012:profile/Profile_01"
	canonical, region, ok := parseKiroProfileArn(" " + valid + " ")
	if !ok || canonical != valid || region != "eu-central-1" {
		t.Fatalf("expected valid ARN, got canonical=%q region=%q ok=%v", canonical, region, ok)
	}

	invalid := []string{
		"arn:aws:codewhisperer:profile/test",
		"arn:aws:s3:eu-central-1:123456789012:profile/test",
		"arn:aws:codewhisperer:eu-central-1.evil:123456789012:profile/test",
		"arn:aws:codewhisperer:eu-central-1:not-an-account:profile/test",
		"arn:aws:codewhisperer:eu-central-1:123456789012:project/test",
		"arn:aws:codewhisperer:eu-central-1:123456789012:profile/test/child",
	}
	for _, candidate := range invalid {
		if _, _, ok := parseKiroProfileArn(candidate); ok {
			t.Errorf("expected invalid ARN to be rejected: %q", candidate)
		}
	}
}

func TestKiroProfileRegionCandidatesExternalIncludesBothDataPlanes(t *testing.T) {
	account := &config.Account{AuthMethod: "external_idp", Region: "us-east-1"}
	got := kiroProfileRegionCandidates(account)
	want := []string{"us-east-1", "eu-central-1"}
	if len(got) != len(want) {
		t.Fatalf("expected candidates %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected candidates %v, got %v", want, got)
		}
	}

}

func TestKiroProfileRegionCandidatesRejectsUnsafeAccountRegion(t *testing.T) {
	got := kiroProfileRegionCandidates(&config.Account{
		AuthMethod: "external_idp",
		Region:     "evil.amazonaws.com",
	})
	want := []string{"us-east-1", "eu-central-1"}
	if len(got) != len(want) {
		t.Fatalf("expected candidates %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected candidates %v, got %v", want, got)
		}
	}
}

func TestDiscoverKiroProfilesAcrossRegionsDeduplicatesAndPreservesAuthRegion(t *testing.T) {
	const (
		usARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/US_PROFILE"
		euARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU_PROFILE"
	)
	var hosts []string
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			hosts = append(hosts, req.URL.Host)
			if got := req.Header.Get("TokenType"); got != "EXTERNAL_IDP" {
				t.Fatalf("expected EXTERNAL_IDP header, got %q", got)
			}
			var body string
			switch req.URL.Host {
			case "codewhisperer.us-east-1.amazonaws.com":
				body = `{"profiles":[
					{"arn":"` + usARN + `","profileName":"US profile"},
					{"arn":"` + usARN + `","profileName":"duplicate"},
					{"arn":"arn:aws:codewhisperer:bad","profileName":"invalid"}
				]}`
			case "q.eu-central-1.amazonaws.com":
				body = `{"profiles":[
					{"arn":"` + euARN + `","profileName":"EU profile"},
					{"arn":"` + usARN + `","profileName":"cross-region duplicate"}
				]}`
			default:
				t.Fatalf("unexpected profile discovery host %q", req.URL.Host)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	account := &config.Account{
		AuthMethod:  "external_idp",
		AccessToken: "access-token",
		Region:      "us-east-1",
	}
	profiles, err := DiscoverKiroProfiles(context.Background(), account)
	if err != nil {
		t.Fatalf("discover profiles: %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("expected two de-duplicated profiles, got %#v", profiles)
	}
	if profiles[0].ARN != usARN || profiles[0].Name != "US profile" || profiles[0].Region != "us-east-1" {
		t.Fatalf("unexpected US profile: %#v", profiles[0])
	}
	if profiles[1].ARN != euARN || profiles[1].Name != "EU profile" || profiles[1].Region != "eu-central-1" {
		t.Fatalf("unexpected EU profile: %#v", profiles[1])
	}
	if account.Region != "us-east-1" {
		t.Fatalf("profile discovery must not change auth region, got %q", account.Region)
	}
	if len(hosts) != 2 {
		t.Fatalf("expected both data planes to be probed, got hosts %v", hosts)
	}
}

func TestDiscoverKiroProfilesReturnsPartialSuccess(t *testing.T) {
	const euARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU_PROFILE"
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			status := http.StatusOK
			body := `{"profiles":[{"arn":"` + euARN + `","profileName":"EU profile"}]}`
			if req.URL.Host == "codewhisperer.us-east-1.amazonaws.com" {
				status = http.StatusForbidden
				body = `{"message":"not provisioned in this region"}`
			}
			return &http.Response{
				StatusCode: status,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	profiles, err := DiscoverKiroProfiles(context.Background(), &config.Account{
		AuthMethod:  "external_idp",
		AccessToken: "access-token",
		Region:      "us-east-1",
	})
	if err != nil {
		t.Fatalf("a failed region must not hide a usable profile: %v", err)
	}
	if len(profiles) != 1 || profiles[0].ARN != euARN {
		t.Fatalf("expected EU partial result, got %#v", profiles)
	}
}

func TestDiscoverKiroProfilesReportsAllRegionFailures(t *testing.T) {
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Body:       io.NopCloser(strings.NewReader(req.URL.Host + " denied")),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	profiles, err := DiscoverKiroProfiles(context.Background(), &config.Account{
		AuthMethod:  "external_idp",
		AccessToken: "access-token",
		Region:      "us-east-1",
	})
	if err == nil {
		t.Fatalf("expected aggregate discovery error, got profiles %#v", profiles)
	}
	for _, want := range []string{"us-east-1", "eu-central-1"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to include %q failure, got %v", want, err)
		}
	}
}

func TestDiscoverKiroProfilesReportsEmptyDiscovery(t *testing.T) {
	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"profiles":[]}`)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	profiles, err := DiscoverKiroProfiles(context.Background(), &config.Account{
		AuthMethod:  "external_idp",
		AccessToken: "access-token",
		Region:      "us-east-1",
	})
	if err == nil || len(profiles) != 0 || !strings.Contains(err.Error(), "empty profile list") {
		t.Fatalf("expected empty discovery error, got profiles=%#v err=%v", profiles, err)
	}
}

func TestResolveProfileArnExternalIDPSkipsRefreshFallback(t *testing.T) {
	var authCalls int32
	oldAuthClient := auth.SetGlobalAuthClientForTest(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&authCalls, 1)
			return &http.Response{
				StatusCode: http.StatusInternalServerError,
				Body:       io.NopCloser(strings.NewReader(`{"error":"unexpected refresh"}`)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { auth.SetGlobalAuthClientForTest(oldAuthClient) })

	kiroRestHttpStore.Store(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"profiles":[]}`)),
				Header:     make(http.Header),
			}, nil
		}),
	})
	t.Cleanup(func() { InitKiroHttpClient("") })

	account := &config.Account{
		AuthMethod:   "external_idp",
		Provider:     "AzureAD",
		AccessToken:  "access-token",
		RefreshToken: "refresh-token",
		ClientID:     "11111111-1111-4111-8111-111111111111",
		TokenEndpoint: "https://login.microsoftonline.com/" +
			"22222222-2222-4222-8222-222222222222/oauth2/v2.0/token",
		IssuerURL: "https://login.microsoftonline.com/" +
			"22222222-2222-4222-8222-222222222222/v2.0",
		Scopes: "openid offline_access",
		Region: "us-east-1",
	}
	if _, err := ResolveProfileArn(account); err == nil {
		t.Fatal("expected missing profile error")
	}
	if got := atomic.LoadInt32(&authCalls); got != 0 {
		t.Fatalf("external profile resolution must not refresh tokens, got %d auth calls", got)
	}
	if account.Region != "us-east-1" {
		t.Fatalf("profile resolution must not change auth region, got %q", account.Region)
	}
}

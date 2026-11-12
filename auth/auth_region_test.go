package auth

import (
	"context"
	"io"
	"kiro-proxy/config"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// stubRefreshNetwork answers every auth request with a token and records its URL host.
func stubRefreshNetwork(t *testing.T) *[]string {
	t.Helper()
	var hosts []string
	client := &http.Client{Transport: authRegionRoundTrip(func(req *http.Request) (*http.Response, error) {
		hosts = append(hosts, req.URL.Host)
		body := `{"accessToken":"a","refreshToken":"r","expiresIn":3600}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: req}, nil
	})}
	old := SetGlobalAuthClientForTest(client)
	t.Cleanup(func() { SetGlobalAuthClientForTest(old) })
	return &hosts
}

type authRegionRoundTrip func(*http.Request) (*http.Response, error)

func (fn authRegionRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func initAuthRegionConfig(t *testing.T) {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateUpstreamConfig(config.UpstreamConfig{}) })
}

func TestOIDCRefreshUsesAuthRegionOverride(t *testing.T) {
	initAuthRegionConfig(t)
	hosts := stubRefreshNetwork(t)

	var regions []string
	oldURL := GetOIDCTokenURLForTest()
	SetOIDCTokenURLForTest(func(region string) string {
		regions = append(regions, region)
		return oldURL(region)
	})
	t.Cleanup(func() { SetOIDCTokenURLForTest(oldURL) })

	for _, method := range []string{"builder-id", "idc"} {
		account := &config.Account{AuthMethod: method, Region: "eu-west-1", RefreshToken: "rt", ClientID: "cid", ClientSecret: "secret"}

		regions, *hosts = nil, nil
		if _, _, _, _, err := RefreshTokenContext(context.Background(), account); err != nil {
			t.Fatalf("%s refresh without override: %v", method, err)
		}
		if len(regions) != 1 || regions[0] != "eu-west-1" || (*hosts)[0] != "oidc.eu-west-1.amazonaws.com" {
			t.Fatalf("%s without override: regions %v hosts %v, want the account region", method, regions, *hosts)
		}

		if err := config.UpdateUpstreamConfig(config.UpstreamConfig{AuthRegion: "ap-southeast-2"}); err != nil {
			t.Fatal(err)
		}
		regions, *hosts = nil, nil
		if _, _, _, _, err := RefreshTokenContext(context.Background(), account); err != nil {
			t.Fatalf("%s refresh with override: %v", method, err)
		}
		if len(regions) != 1 || regions[0] != "ap-southeast-2" || (*hosts)[0] != "oidc.ap-southeast-2.amazonaws.com" {
			t.Fatalf("%s with override: regions %v hosts %v, want the override", method, regions, *hosts)
		}
		if account.Region != "eu-west-1" {
			t.Fatalf("the override must not rewrite the stored account region, got %q", account.Region)
		}

		//! The API region override is a different setting and never moves the sign-in host.
		if err := config.UpdateUpstreamConfig(config.UpstreamConfig{APIRegion: "eu-central-1"}); err != nil {
			t.Fatal(err)
		}
		regions, *hosts = nil, nil
		if _, _, _, _, err := RefreshTokenContext(context.Background(), account); err != nil {
			t.Fatalf("%s refresh with apiRegion: %v", method, err)
		}
		if len(regions) != 1 || regions[0] != "eu-west-1" {
			t.Fatalf("%s: apiRegion moved the OIDC refresh to %v", method, regions)
		}
		if err := config.UpdateUpstreamConfig(config.UpstreamConfig{}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSocialRefreshIgnoresAuthRegion(t *testing.T) {
	initAuthRegionConfig(t)
	hosts := stubRefreshNetwork(t)

	oidcCalls := 0
	oldURL := GetOIDCTokenURLForTest()
	SetOIDCTokenURLForTest(func(region string) string {
		oidcCalls++
		return oldURL(region)
	})
	t.Cleanup(func() { SetOIDCTokenURLForTest(oldURL) })

	if err := config.UpdateUpstreamConfig(config.UpstreamConfig{AuthRegion: "eu-central-1"}); err != nil {
		t.Fatal(err)
	}
	account := &config.Account{AuthMethod: "social", Region: "us-east-1", RefreshToken: "rt"}
	if _, _, _, _, err := RefreshTokenContext(context.Background(), account); err != nil {
		t.Fatalf("social refresh: %v", err)
	}
	if oidcCalls != 0 {
		t.Fatalf("social refresh must not use the OIDC host")
	}
	if len(*hosts) != 1 || (*hosts)[0] != "prod.us-east-1.auth.desktop.kiro.dev" {
		t.Fatalf("social refresh hosts = %v, want the fixed Kiro auth host", *hosts)
	}
}

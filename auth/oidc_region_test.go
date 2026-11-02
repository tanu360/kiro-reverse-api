package auth

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type countingAuthTransport struct{ calls int32 }

func (c *countingAuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	atomic.AddInt32(&c.calls, 1)
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header), Request: req}, nil
}

var unsafeOIDCRegions = []string{
	"@evil.example/x#",
	"evil.example",
	"us-east-1.evil.example",
	"us-east-1/../x",
}

func TestOIDCTokenURLRefusesUnsafeRegion(t *testing.T) {
	if got := oidcTokenURL("eu-central-1"); got != "https://oidc.eu-central-1.amazonaws.com/token" {
		t.Fatalf("valid region URL = %q", got)
	}
	for _, region := range unsafeOIDCRegions {
		if got := oidcTokenURL(region); got != "" {
			t.Fatalf("oidcTokenURL(%q) = %q, want no URL", region, got)
		}
	}
}

func TestOIDCFlowsRefuseUnsafeRegionBeforeAnyRequest(t *testing.T) {
	transport := &countingAuthTransport{}
	client := &http.Client{Transport: transport}
	old := SetGlobalAuthClientForTest(client)
	t.Cleanup(func() { SetGlobalAuthClientForTest(old) })

	for _, region := range unsafeOIDCRegions {
		if _, _, _, _, err := refreshOIDCToken(context.Background(), "refresh", "client", "secret", region, client); err == nil {
			t.Errorf("refresh with region %q: expected error", region)
		}
		if _, err := StartBuilderIdLogin(region); err == nil {
			t.Errorf("Builder ID start with region %q: expected error", region)
		}
		if _, _, _, err := StartIamSsoLogin("https://view.awsapps.com/start", region); err == nil {
			t.Errorf("IAM SSO start with region %q: expected error", region)
		}
		if _, _, _, _, _, err := ImportFromSsoToken("bearer", region); err == nil {
			t.Errorf("SSO token import with region %q: expected error", region)
		}
	}
	if got := atomic.LoadInt32(&transport.calls); got != 0 {
		t.Fatalf("an unsafe region must never reach the network, got %d requests", got)
	}
}

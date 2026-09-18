package proxy

import (
	"kiro-proxy/config"
	"net/http"
	"strings"
	"testing"
)

func TestBuildStreamingHeaderValuesAlignsWithKiroIDEFormat(t *testing.T) {
	account := &config.Account{MachineId: "machine-123"}
	values := buildStreamingHeaderValues(account, "q.us-east-1.amazonaws.com")

	if values.Host != "q.us-east-1.amazonaws.com" {
		t.Fatalf("expected host to be preserved, got %q", values.Host)
	}
	if !strings.Contains(values.UserAgent, "aws-sdk-js/1.0.34") {
		t.Fatalf("expected streaming sdk version in user agent, got %q", values.UserAgent)
	}
	if !strings.Contains(values.UserAgent, "api/codewhispererstreaming#1.0.34") {
		t.Fatalf("expected streaming API marker in user agent, got %q", values.UserAgent)
	}
	if !strings.Contains(values.UserAgent, "KiroIDE-0.11.107-machine-123") {
		t.Fatalf("expected kiro version and machine id in user agent, got %q", values.UserAgent)
	}
	if !strings.Contains(values.AmzUserAgent, "aws-sdk-js/1.0.34 KiroIDE-0.11.107-machine-123") {
		t.Fatalf("expected x-amz-user-agent to include version and machine id, got %q", values.AmzUserAgent)
	}
}

func TestBuildRuntimeHeaderValuesUsesRuntimeAPIFormat(t *testing.T) {
	account := &config.Account{MachineId: "machine-456"}
	values := buildRuntimeHeaderValues(account, "codewhisperer.us-east-1.amazonaws.com")

	if !strings.Contains(values.UserAgent, "aws-sdk-js/1.0.0") {
		t.Fatalf("expected runtime sdk version in user agent, got %q", values.UserAgent)
	}
	if !strings.Contains(values.UserAgent, "api/codewhispererruntime#1.0.0") {
		t.Fatalf("expected runtime API marker in user agent, got %q", values.UserAgent)
	}
	if !strings.Contains(values.UserAgent, "m/N,E") {
		t.Fatalf("expected runtime mode marker in user agent, got %q", values.UserAgent)
	}
}

func TestApplyKiroBaseHeadersMarksAPIKeyCredentials(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://runtime.us-east-1.kiro.dev/", nil)
	if err != nil {
		t.Fatal(err)
	}
	account := &config.Account{
		KiroApiKey:  "ksk_test_key",
		AccessToken: "should-not-win",
		AuthMethod:  config.AuthMethodAPIKey,
	}

	applyKiroBaseHeaders(req, account, buildStreamingHeaderValues(account, req.URL.Host))

	if got := req.Header.Get("Authorization"); got != "Bearer ksk_test_key" {
		t.Fatalf("expected API key bearer, got %q", got)
	}
	if got := req.Header.Get("tokentype"); got != "API_KEY" {
		t.Fatalf("expected tokentype API_KEY, got %q", got)
	}
}

func TestApplyKiroBaseHeadersClearsTokenTypeForOAuth(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://q.us-east-1.amazonaws.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	//! Headers are set on a reused request per retry; a leftover marker must not leak onto an OAuth token.
	req.Header.Set("TokenType", "API_KEY")
	account := &config.Account{AccessToken: "oauth-access", AuthMethod: "social"}

	applyKiroBaseHeaders(req, account, buildStreamingHeaderValues(account, req.URL.Host))

	if got := req.Header.Get("Authorization"); got != "Bearer oauth-access" {
		t.Fatalf("expected OAuth bearer, got %q", got)
	}
	if got := req.Header.Get("tokentype"); got != "" {
		t.Fatalf("expected no tokentype for OAuth, got %q", got)
	}
}

func TestApplyKiroBaseHeadersMarksExternalIdpTokens(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://q.us-east-1.amazonaws.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	account := &config.Account{AccessToken: "entra-access", AuthMethod: " External_IDP "}

	applyKiroBaseHeaders(req, account, buildRuntimeHeaderValues(account, req.URL.Host))

	if got := req.Header.Get("Authorization"); got != "Bearer entra-access" {
		t.Fatalf("expected Entra bearer, got %q", got)
	}
	if got := req.Header.Get("tokentype"); got != "EXTERNAL_IDP" {
		t.Fatalf("expected tokentype EXTERNAL_IDP, got %q", got)
	}
}

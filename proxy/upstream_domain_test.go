package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const (
	upstreamTestUSArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/us"
	upstreamTestEUArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/eu"
)

// initUpstreamTest starts a fresh config and puts the upstream and endpoint settings back to
// their defaults afterwards, since later tests in the package may run without config.Init.
func initUpstreamTest(t *testing.T) {
	t.Helper()
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() {
		_ = config.UpdateUpstreamConfig(config.UpstreamConfig{})
		_ = config.UpdatePreferredEndpoint("auto")
		_ = config.UpdateEndpointFallback(true)
	})
}

func setUpstreamForTest(t *testing.T, u config.UpstreamConfig) {
	t.Helper()
	if err := config.UpdateUpstreamConfig(u); err != nil {
		t.Fatalf("UpdateUpstreamConfig(%+v): %v", u, err)
	}
}

func endpointByName(t *testing.T, name string) kiroEndpoint {
	t.Helper()
	for _, ep := range kiroEndpoints {
		if ep.Name == name {
			return ep
		}
	}
	t.Fatalf("no endpoint %q", name)
	return kiroEndpoint{}
}

func TestKiroEndpointURLDomainRegionMatrix(t *testing.T) {
	initUpstreamTest(t)

	const path = "/generateAssistantResponse"
	arns := map[string]string{"no ARN": "", "us ARN": upstreamTestUSArn, "eu ARN": upstreamTestEUArn}
	want := map[string]map[string]map[string]string{
		config.APIDomainAmazonaws: {
			"no ARN": {
				"Kiro IDE":      "https://q.us-east-1.amazonaws.com" + path,
				"CodeWhisperer": "https://codewhisperer.us-east-1.amazonaws.com" + path,
				"AmazonQ":       "https://q.us-east-1.amazonaws.com" + path,
			},
			"us ARN": {
				"Kiro IDE":      "https://q.us-east-1.amazonaws.com" + path,
				"CodeWhisperer": "https://codewhisperer.us-east-1.amazonaws.com" + path,
				"AmazonQ":       "https://q.us-east-1.amazonaws.com" + path,
			},
			"eu ARN": {
				"Kiro IDE":      "https://q.eu-central-1.amazonaws.com" + path,
				"CodeWhisperer": "https://q.eu-central-1.amazonaws.com" + path,
				"AmazonQ":       "https://q.eu-central-1.amazonaws.com" + path,
			},
		},
		config.APIDomainKiro: {
			"no ARN": {
				"Kiro IDE":      "https://runtime.us-east-1.kiro.dev" + path,
				"CodeWhisperer": "https://runtime.us-east-1.kiro.dev" + path,
				"AmazonQ":       "https://runtime.us-east-1.kiro.dev" + path,
			},
			"us ARN": {
				"Kiro IDE":      "https://runtime.us-east-1.kiro.dev" + path,
				"CodeWhisperer": "https://runtime.us-east-1.kiro.dev" + path,
				"AmazonQ":       "https://runtime.us-east-1.kiro.dev" + path,
			},
			"eu ARN": {
				"Kiro IDE":      "https://runtime.eu-central-1.kiro.dev" + path,
				"CodeWhisperer": "https://runtime.eu-central-1.kiro.dev" + path,
				"AmazonQ":       "https://runtime.eu-central-1.kiro.dev" + path,
			},
		},
	}

	for _, domain := range []string{config.APIDomainAmazonaws, config.APIDomainKiro} {
		setUpstreamForTest(t, config.UpstreamConfig{APIDomain: domain})
		for arnName, arn := range arns {
			//! The ARN comes once from the payload and once from the stored account: both name the region.
			for _, source := range []string{"payload", "account"} {
				account := &config.Account{AccessToken: "token", AuthMethod: "social", Region: "ap-southeast-2"}
				payloadArn := arn
				if source == "account" {
					account.ProfileArn, payloadArn = arn, ""
				}
				for epName, wantURL := range want[domain][arnName] {
					if got := kiroEndpointURL(endpointByName(t, epName), account, payloadArn); got != wantURL {
						t.Errorf("%s / %s (%s) / %s: got %q, want %q", domain, arnName, source, epName, got, wantURL)
					}
				}
			}
		}

		//! API keys keep the CLI runtime on both domains, named by their own region.
		apiKey := &config.Account{AuthMethod: config.AuthMethodAPIKey, KiroApiKey: "ksk_x", Region: "eu-central-1", ProfileArn: upstreamTestUSArn}
		eps := endpointsForAccount(apiKey)
		if len(eps) != 1 || eps[0].Name != "Kiro CLI" {
			t.Fatalf("%s: API key endpoints = %+v", domain, eps)
		}
		if got := kiroEndpointURL(eps[0], apiKey, upstreamTestUSArn); got != "https://runtime.eu-central-1.kiro.dev/" {
			t.Errorf("%s: API key URL = %q", domain, got)
		}
	}
}

func TestAPIRegionOverridePrecedence(t *testing.T) {
	initUpstreamTest(t)

	oauthNoArn := &config.Account{AccessToken: "token", AuthMethod: "idc", Region: "ap-southeast-2"}
	oauthEU := &config.Account{AccessToken: "token", AuthMethod: "social", ProfileArn: upstreamTestEUArn}
	apiKeyEU := &config.Account{AuthMethod: config.AuthMethodAPIKey, KiroApiKey: "ksk_x", Region: "eu-central-1"}

	type check struct {
		name       string
		account    *config.Account
		profileArn string
		want       string
	}
	run := func(label string, checks []check) {
		t.Helper()
		for _, c := range checks {
			if got := kiroRegionForProfile(c.account, c.profileArn); got != c.want {
				t.Errorf("%s / %s: region = %q, want %q", label, c.name, got, c.want)
			}
		}
	}

	//! No override: today's rules. ARN for OAuth (payload first), us-east-1 without one, Region for API keys.
	run("no override", []check{
		{"oauth without ARN ignores its auth region", oauthNoArn, "", "us-east-1"},
		{"oauth uses the stored ARN", oauthEU, "", "eu-central-1"},
		{"payload ARN beats the stored ARN", oauthEU, upstreamTestUSArn, "us-east-1"},
		{"API key uses its region", apiKeyEU, upstreamTestUSArn, "eu-central-1"},
	})

	setUpstreamForTest(t, config.UpstreamConfig{APIRegion: "us-east-1"})
	run("override us-east-1", []check{
		{"beats the stored ARN", oauthEU, "", "us-east-1"},
		{"beats the payload ARN", oauthEU, upstreamTestEUArn, "us-east-1"},
		{"beats the API key region", apiKeyEU, "", "us-east-1"},
		{"applies to nil accounts", nil, "", "us-east-1"},
	})
	if got := regionalizeURLForProfile("https://q.us-east-1.amazonaws.com/generateAssistantResponse", oauthEU, ""); got != "https://q.us-east-1.amazonaws.com/generateAssistantResponse" {
		t.Errorf("override us-east-1 must keep the us host, got %q", got)
	}
	if got := kiroEndpointURL(kiroCLIEndpoint, apiKeyEU, ""); got != "https://runtime.us-east-1.kiro.dev/" {
		t.Errorf("API key under override = %q", got)
	}

	setUpstreamForTest(t, config.UpstreamConfig{APIRegion: "eu-central-1"})
	run("override eu-central-1", []check{
		{"moves an account without ARN", oauthNoArn, "", "eu-central-1"},
		{"beats a us payload ARN", oauthEU, upstreamTestUSArn, "eu-central-1"},
	})

	//! Both settings together: the override picks the region, the domain picks the host family.
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro, APIRegion: "eu-central-1"})
	usAccount := &config.Account{AccessToken: "token", ProfileArn: upstreamTestUSArn}
	if got := kiroEndpointURL(endpointByName(t, "CodeWhisperer"), usAccount, ""); got != "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse" {
		t.Errorf("kiro + eu override = %q", got)
	}
	if got := webSearchMCPHost(usAccount); got != "https://runtime.eu-central-1.kiro.dev" {
		t.Errorf("kiro + eu override MCP host = %q", got)
	}

	setUpstreamForTest(t, config.UpstreamConfig{})
	run("cleared", []check{
		{"back to the ARN", oauthEU, "", "eu-central-1"},
		{"back to the API key region", apiKeyEU, "", "eu-central-1"},
	})
}

func TestWebSearchMCPHostFollowsAPIDomain(t *testing.T) {
	initUpstreamTest(t)

	noArn := &config.Account{AccessToken: "token", Region: "ap-southeast-2"}
	eu := &config.Account{AccessToken: "token", ProfileArn: upstreamTestEUArn}
	apiKey := &config.Account{AuthMethod: config.AuthMethodAPIKey, KiroApiKey: "ksk_x", Region: "eu-central-1"}
	cases := map[string]map[*config.Account]string{
		config.APIDomainAmazonaws: {
			noArn:  "https://q.us-east-1.amazonaws.com",
			eu:     "https://q.eu-central-1.amazonaws.com",
			apiKey: "https://q.eu-central-1.amazonaws.com",
		},
		config.APIDomainKiro: {
			noArn:  "https://runtime.us-east-1.kiro.dev",
			eu:     "https://runtime.eu-central-1.kiro.dev",
			apiKey: "https://runtime.eu-central-1.kiro.dev",
		},
	}
	for _, domain := range []string{config.APIDomainAmazonaws, config.APIDomainKiro} {
		setUpstreamForTest(t, config.UpstreamConfig{APIDomain: domain})
		for account, want := range cases[domain] {
			if got := webSearchMCPHost(account); got != want {
				t.Errorf("%s / %s: MCP host = %q, want %q", domain, account.AuthMethod+account.ProfileArn, got, want)
			}
		}
	}
}

func TestApplyAPIDomainOnlyMovesDataPlaneHosts(t *testing.T) {
	initUpstreamTest(t)
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro})

	for raw, want := range map[string]string{
		"https://q.us-east-1.amazonaws.com/generateAssistantResponse":             "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		"https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse": "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		"https://q.eu-central-1.amazonaws.com/mcp?x=1":                            "https://runtime.eu-central-1.kiro.dev/mcp?x=1",
		"https://runtime.us-east-1.kiro.dev/":                                     "https://runtime.us-east-1.kiro.dev/",
		"https://oidc.us-east-1.amazonaws.com/token":                              "https://oidc.us-east-1.amazonaws.com/token",
		"https://q.evil.example.amazonaws.com/x":                                  "https://q.evil.example.amazonaws.com/x",
	} {
		if got := applyAPIDomain(raw, "eu-central-1"); got != want {
			t.Errorf("applyAPIDomain(%q) = %q, want %q", raw, got, want)
		}
	}
	//! A region that is not a plain region code never reaches the hostname.
	if got := applyAPIDomain("https://q.us-east-1.amazonaws.com/x", "evil.example/"); got != "https://runtime.us-east-1.kiro.dev/x" {
		t.Errorf("unsafe region = %q", got)
	}

	setUpstreamForTest(t, config.UpstreamConfig{})
	if got := applyAPIDomain("https://q.us-east-1.amazonaws.com/x", "eu-central-1"); got != "https://q.us-east-1.amazonaws.com/x" {
		t.Errorf("amazonaws mode must pass URLs through, got %q", got)
	}
}

func TestRESTCallsStayOnAmazonawsUnderKiroDomain(t *testing.T) {
	initUpstreamTest(t)
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro})

	var hosts []string
	stubRestTransport(t, func(req *http.Request) (*http.Response, error) {
		hosts = append(hosts, req.URL.Host+req.URL.Path)
		if req.Host != "" && req.Host != req.URL.Host {
			t.Errorf("Host header %q does not match URL host %q", req.Host, req.URL.Host)
		}
		if strings.HasSuffix(req.URL.Path, "/ListAvailableModels") {
			return jsonResponse(http.StatusOK, `{"models":[]}`), nil
		}
		return jsonResponse(http.StatusOK, `{}`), nil
	})

	account := &config.Account{AccessToken: "token", AuthMethod: "social", ProfileArn: upstreamTestUSArn}
	if _, err := GetUsageLimits(account); err != nil {
		t.Fatalf("GetUsageLimits: %v", err)
	}
	if _, err := ListAvailableModels(account); err != nil {
		t.Fatalf("ListAvailableModels: %v", err)
	}
	want := []string{
		"codewhisperer.us-east-1.amazonaws.com/getUsageLimits",
		"q.us-east-1.amazonaws.com/ListAvailableModels",
	}
	if !reflect.DeepEqual(hosts, want) {
		t.Fatalf("REST hosts = %v, want %v", hosts, want)
	}

	//! apiRegion still moves REST calls, on the amazonaws hosts.
	hosts = nil
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro, APIRegion: "eu-central-1"})
	if _, err := GetUsageLimits(account); err != nil {
		t.Fatalf("GetUsageLimits: %v", err)
	}
	if _, err := ListAvailableModels(account); err != nil {
		t.Fatalf("ListAvailableModels: %v", err)
	}
	want = []string{
		"q.eu-central-1.amazonaws.com/getUsageLimits",
		"q.eu-central-1.amazonaws.com/ListAvailableModels",
	}
	if !reflect.DeepEqual(hosts, want) {
		t.Fatalf("REST hosts with eu override = %v, want %v", hosts, want)
	}
}

func TestEndpointPreferenceComposesWithKiroDomain(t *testing.T) {
	initUpstreamTest(t)
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro})
	account := &config.Account{AccessToken: "token", ProfileArn: upstreamTestUSArn}
	const runtimeURL = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse"

	if err := config.UpdatePreferredEndpoint("amazonq"); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateEndpointFallback(false); err != nil {
		t.Fatal(err)
	}
	eps := endpointsForAccount(account)
	if len(eps) != 1 || eps[0].AmzTarget != "AmazonQDeveloperStreamingService.SendMessage" {
		t.Fatalf("amazonq without fallback = %+v", eps)
	}
	if got := kiroEndpointURL(eps[0], account, ""); got != runtimeURL {
		t.Fatalf("amazonq URL = %q", got)
	}

	if err := config.UpdateEndpointFallback(true); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, ep := range endpointsForAccount(account) {
		names = append(names, ep.Name)
		if got := kiroEndpointURL(ep, account, ""); got != runtimeURL {
			t.Errorf("%s URL = %q, want %q", ep.Name, got, runtimeURL)
		}
	}
	if want := []string{"AmazonQ", "Kiro IDE", "CodeWhisperer"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("fallback order = %v, want %v", names, want)
	}
}

func TestAPIDomainHotSwitch(t *testing.T) {
	initUpstreamTest(t)

	var captured []*http.Request
	oldClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		captured = append(captured, req)
		frames := append(
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hi"}),
			meteringFrame(t)...,
		)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(frames)), Header: make(http.Header)}, nil
	})})
	t.Cleanup(func() { kiroHttpStore.Store(oldClient) })

	account := &config.Account{ID: "oauth-1", AccessToken: "token", AuthMethod: "social", ProfileArn: upstreamTestUSArn}
	call := func() *http.Request {
		t.Helper()
		before := len(captured)
		if err := CallKiroAPIContext(context.Background(), account, testKiroPayload(), &KiroStreamCallback{}); err != nil {
			t.Fatalf("CallKiroAPIContext: %v", err)
		}
		if len(captured) != before+1 {
			t.Fatalf("expected one upstream request, got %d", len(captured)-before)
		}
		return captured[len(captured)-1]
	}
	checkHost := func(req *http.Request, want string) {
		t.Helper()
		if req.URL.Host != want || req.Host != want {
			t.Fatalf("URL host %q / Host header %q, want %q", req.URL.Host, req.Host, want)
		}
		if req.URL.Path != "/generateAssistantResponse" {
			t.Fatalf("path = %q", req.URL.Path)
		}
	}

	checkHost(call(), "q.us-east-1.amazonaws.com")

	//! No restart, no new client: the next request reads the new domain.
	setUpstreamForTest(t, config.UpstreamConfig{APIDomain: config.APIDomainKiro})
	req := call()
	checkHost(req, "runtime.us-east-1.kiro.dev")
	for header, want := range map[string]string{
		"Authorization":          "Bearer token",
		"Content-Type":           "application/json",
		"x-amzn-kiro-agent-mode": "vibe",
		"X-Amz-Target":           "",
		"tokentype":              "",
	} {
		if got := req.Header.Get(header); got != want {
			t.Errorf("header %s = %q, want %q", header, got, want)
		}
	}
	if ua := req.Header.Get("User-Agent"); !strings.Contains(ua, "api/codewhispererstreaming") {
		t.Errorf("User-Agent = %q, want the IDE streaming agent", ua)
	}

	setUpstreamForTest(t, config.UpstreamConfig{})
	checkHost(call(), "q.us-east-1.amazonaws.com")
}

func TestAdminUpstreamGetPost(t *testing.T) {
	h := newRegionTestAdmin(t)
	t.Cleanup(func() { _ = config.UpdateUpstreamConfig(config.UpstreamConfig{}) })

	get := func() map[string]interface{} {
		t.Helper()
		rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/upstream", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET status = %d body=%s", rec.Code, rec.Body.String())
		}
		var body map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body
	}
	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		return serveRegionTestAdmin(h, http.MethodPost, "/admin/api/upstream", body)
	}
	expectError := func(rec *httptest.ResponseRecorder, code string) {
		t.Helper()
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusBadRequest || body.Code != code {
			t.Fatalf("status %d code %q body=%s, want 400 %q", rec.Code, body.Code, rec.Body.String(), code)
		}
	}

	want := map[string]interface{}{
		"apiDomain":  "amazonaws",
		"authRegion": "",
		"apiRegion":  "",
		"apiRegions": []interface{}{"us-east-1", "eu-central-1"},
	}
	if got := get(); !reflect.DeepEqual(got, want) {
		t.Fatalf("default GET = %v, want %v", got, want)
	}

	if rec := post(`{"apiDomain":"kiro"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST domain: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"apiRegion":"EU-CENTRAL-1","authRegion":"eu-west-1"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST regions: %d %s", rec.Code, rec.Body.String())
	}
	got := get()
	if got["apiDomain"] != "kiro" || got["apiRegion"] != "eu-central-1" || got["authRegion"] != "eu-west-1" {
		t.Fatalf("after partial updates = %v", got)
	}

	//! "" clears one override and leaves the omitted fields alone.
	if rec := post(`{"authRegion":""}`); rec.Code != http.StatusOK {
		t.Fatalf("POST clear: %d %s", rec.Code, rec.Body.String())
	}
	if got := config.GetUpstreamConfig(); got != (config.UpstreamConfig{APIDomain: "kiro", APIRegion: "eu-central-1"}) {
		t.Fatalf("after clearing authRegion = %+v", got)
	}

	before := config.GetUpstreamConfig()
	expectError(post(`{"apiDomain":"evil.example"}`), "invalid_api_domain")
	expectError(post(`{"apiRegion":"us-west-2"}`), "invalid_region")
	expectError(post(`{"authRegion":"evil.com/x"}`), "invalid_region")
	expectError(post(`{"apiDomain":"amazonaws","apiRegion":"us-west-2"}`), "invalid_region")
	expectError(post(`{"apiDomain":`), "invalid_json")
	expectError(post(`{"apiDomain":1}`), "invalid_json")
	if got := config.GetUpstreamConfig(); got != before {
		t.Fatalf("a rejected POST must change nothing: %+v, want %+v", got, before)
	}

	//! The route sits behind admin auth like every other /admin/api route.
	req := httptest.NewRequest(http.MethodPost, "/admin/api/upstream", strings.NewReader(`{"apiDomain":"amazonaws"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST status = %d, want 401", rec.Code)
	}
	if got := config.GetAPIDomain(); got != "kiro" {
		t.Fatalf("unauthenticated POST changed the domain to %q", got)
	}
}

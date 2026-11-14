package proxy

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/proxypool"
)

const (
	transportPlainBody = `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`
	transportLoopBody  = `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"What is the latest Go?"}]}`
	transportDirectBody = `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"Perform a web search for the query: go"}]}`
)

func postClientAPI(h *Handler, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return rec
}

func setTestAccountProxy(t *testing.T, h *Handler, proxyURL string) config.Account {
	t.Helper()
	acc := config.GetAccounts()[0]
	acc.ProxyURL = proxyURL
	if err := config.UpdateAccount(acc.ID, acc); err != nil {
		t.Fatal(err)
	}
	h.pool.Reload()
	return acc
}

func assertAccountNotBanned(t *testing.T, id string) {
	t.Helper()
	for _, a := range config.GetAccounts() {
		if a.ID == id && (!a.Enabled || a.BanStatus != "") {
			t.Fatalf("a proxy failure disabled the account: enabled=%v ban=%q reason=%q", a.Enabled, a.BanStatus, a.BanReason)
		}
	}
}

// An account's own proxy that is down answers every client endpoint as a dead
// pool proxy does: 503 with fixed wording, never the upstream URL or the
// proxy's address, and the account is not banned.
func TestOwnProxyDownAnswers503WithoutAddress(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("a request reached Kiro past a dead proxy") })
	stubMCPWebSearch(t, http.StatusOK, mcpOneResult)
	addr := poolClosedPort(t)
	_, port, _ := net.SplitHostPort(addr)
	acc := setTestAccountProxy(t, h, "http://user:own-proxy-secret@"+addr)

	streamBody := strings.Replace(transportPlainBody, `"max_tokens":64`, `"max_tokens":64,"stream":true`, 1)
	for _, c := range []struct{ name, path, body string }{
		{"messages", "/v1/messages", transportPlainBody},
		{"messages-stream", "/v1/messages", streamBody},
		{"chat", "/v1/chat/completions", `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`},
		{"chat-stream", "/v1/chat/completions", `{"model":"claude-sonnet-4.5","stream":true,"messages":[{"role":"user","content":"hi"}]}`},
		{"responses", "/v1/responses", `{"model":"claude-sonnet-4.5","input":"hi"}`},
		{"responses-stream", "/v1/responses", `{"model":"claude-sonnet-4.5","stream":true,"input":"hi"}`},
		{"web-search-loop", "/v1/messages", transportLoopBody},
		{"web-search-direct", "/v1/messages", transportDirectBody},
	} {
		h.pool.ClearCooldown(acc.ID)
		rec := postClientAPI(h, c.path, c.body)
		body := rec.Body.String()
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(body, "outbound proxy failed: connection refused or reset") {
			t.Errorf("%s: %d %s, want 503 with the fixed proxy wording", c.name, rec.Code, body)
		}
		for _, leak := range []string{port, "127.0.0.1", "own-proxy-secret", "proxyconnect", "http://", "https://"} {
			if strings.Contains(body, leak) {
				t.Errorf("%s: client body holds %q: %s", c.name, leak, body)
			}
		}
	}
	assertAccountNotBanned(t, acc.ID)
}

// A proxy that refuses the CONNECT answers with a reason phrase ("Forbidden")
// that read as a Kiro auth failure and banned an account whose token was fine.
func TestOwnProxyConnectForbiddenNeitherBansNorHoldsRPMStart(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("a request reached Kiro past a refusing proxy") })
	old := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{{URL: "https://kiro.invalid/generateAssistantResponse", Origin: "AI_EDITOR", Name: "test"}}
	t.Cleanup(func() { kiroEndpoints = old })
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	t.Cleanup(refusing.Close)
	acc := setTestAccountProxy(t, h, refusing.URL)
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}

	for i := 1; i <= 2; i++ {
		h.pool.ClearCooldown(acc.ID)
		rec := postClientAPI(h, "/v1/messages", transportPlainBody)
		body := rec.Body.String()
		//! The second request would read 429 "per minute" if the first had kept its start.
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(body, "outbound proxy failed: proxy refused the tunnel") {
			t.Fatalf("request %d: %d %s, want 503 naming the refused tunnel", i, rec.Code, body)
		}
		if strings.Contains(body, "kiro.invalid") || strings.Contains(body, refusing.Listener.Addr().String()) {
			t.Fatalf("request %d: client body holds the URL or the proxy address: %s", i, body)
		}
	}
	assertAccountNotBanned(t, acc.ID)
	if at := h.pool.AtRPMLimit(); at[acc.ID] {
		t.Fatalf("AtRPMLimit = %v: a try that never reached Kiro kept its start", at)
	}
}

// With no healthy pool proxy every account's try fails at once. Those tries
// never reached Kiro, so they give their RPM starts back and the next request
// still reads the outage, not 429.
func TestNoHealthyPoolGivesRPMStartsBack(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a request reached Kiro without a healthy pool proxy")
	})
	t.Cleanup(proxypool.SetCheckTargetForTest("http://kiro.test/", nil))
	proxypool.Default().ResetForTest()
	t.Cleanup(proxypool.Default().ResetForTest)
	t.Cleanup(dropPoolClients)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t)}
	if err := config.SetProxyPool([]config.PoolProxy{dead}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	disablePoolProxy(dead.ID)
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	h.pool.Reload()

	for i, body := range []string{transportPlainBody, transportPlainBody, transportLoopBody, transportDirectBody, transportPlainBody} {
		rec := postClientAPI(h, "/v1/messages", body)
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), proxypool.ErrNoHealthyProxy.Error()) {
			t.Fatalf("request %d: %d %s, want 503 with the no-healthy message", i+1, rec.Code, rec.Body.String())
		}
	}
	if at := h.pool.AtRPMLimit(); len(at) != 0 {
		t.Fatalf("AtRPMLimit = %v after requests that never reached Kiro", at)
	}
}

// A try that reached Kiro keeps its start, whatever the error.
func TestRPMStartKeptForATryThatReachedKiro(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)
	})
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	if rec := postClientAPI(h, "/v1/messages", transportPlainBody); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d %s, want 500", rec.Code, rec.Body.String())
	}
	if at := h.pool.AtRPMLimit(); !at["only"] {
		t.Fatalf("AtRPMLimit = %v, want the account at its one start", at)
	}
}

// The web search loop answers an upstream failure as /v1/messages does: a 400
// stays a non-retryable invalid_request_error, a 429 a rate_limit_error with
// its Retry-After.
func TestWebSearchLoopUpstreamStatusMatchesPlainMessages(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body       string
		wantType   string
		retryAfter string
	}{
		{http.StatusBadRequest, `{"message":"Improperly formed request."}`, "invalid_request_error", ""},
		{http.StatusTooManyRequests, `{"message":"Too many requests"}`, "rate_limit_error", "7"},
	} {
		h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
			if tc.retryAfter != "" {
				w.Header().Set("Retry-After", tc.retryAfter)
			}
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		for _, c := range []struct{ name, body string }{{"plain", transportPlainBody}, {"loop", transportLoopBody}} {
			h.pool.ClearCooldown("only")
			rec := postClientAPI(h, "/v1/messages", c.body)
			if rec.Code != tc.status || !strings.Contains(rec.Body.String(), `"type":"`+tc.wantType+`"`) || rec.Header().Get("Retry-After") != tc.retryAfter {
				t.Errorf("upstream %d, %s: %d retry-after=%q %s; want %d %s retry-after=%q",
					tc.status, c.name, rec.Code, rec.Header().Get("Retry-After"), rec.Body.String(), tc.status, tc.wantType, tc.retryAfter)
			}
		}
	}
}

func TestUpstreamTransportErrorText(t *testing.T) {
	post := func(inner error) error {
		return &url.Error{Op: "Post", URL: "https://q.us-east-1.amazonaws.com/generateAssistantResponse?profileArn=arn:aws:x:401", Err: inner}
	}
	for _, c := range []struct {
		name string
		err  error
		want string
	}{
		{"own proxy down", post(&net.OpError{Op: "proxyconnect", Net: "tcp", Err: errors.New("dial tcp 10.0.0.9:3128: connect: connection refused")}), "outbound proxy failed: connection refused or reset"},
		{"CONNECT refused", post(errors.New("Forbidden")), "outbound proxy failed: proxy refused the tunnel"},
		{"CONNECT sign-in", post(errors.New("Proxy Authentication Required")), "outbound proxy failed: proxy rejected the sign-in"},
		{"SOCKS sign-in", post(&net.OpError{Op: "socks connect", Net: "tcp", Err: errors.New("username/password authentication failed")}), "outbound proxy failed: proxy rejected the sign-in"},
		{"direct dial", post(&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("lookup q.us-east-1.amazonaws.com: no such host")}), "upstream connection failed"},
		{"mid-stream reset", &net.OpError{Op: "read", Net: "tcp", Err: errors.New("10.0.0.9:3128: connection reset by peer")}, "upstream connection failed"},
	} {
		if !isUpstreamTransportError(c.err) {
			t.Errorf("%s: not read as a transport error", c.name)
		}
		if got := upstreamErrorText(c.err); got != c.want {
			t.Errorf("%s: client text %q, want %q", c.name, got, c.want)
		}
		if got := upstreamFailureStatus(c.err); got != http.StatusServiceUnavailable {
			t.Errorf("%s: status %d, want 503", c.name, got)
		}
	}
	for _, err := range []error{
		errors.New("HTTP 403 from test: forbidden"),
		&upstreamClientError{status: 400, message: "HTTP 400"},
		proxypool.NoHealthyError(),
	} {
		if isUpstreamTransportError(err) {
			t.Errorf("%v read as a transport error", err)
		}
	}
}

// A SOCKS sign-in failure or a CONNECT 403 on the account's own proxy only
// cools the account; an HTTP 403 from Kiro still bans it.
func TestHandleAccountFailureNeverBansOnTransportError(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {})
	acc := testAccount(t)
	for _, err := range []error{
		&url.Error{Op: "Post", URL: "https://kiro.invalid/", Err: errors.New("Forbidden")},
		&url.Error{Op: "Post", URL: "https://kiro.invalid/", Err: &net.OpError{Op: "socks connect", Net: "tcp", Err: errors.New("username/password authentication failed")}},
	} {
		h.handleAccountFailure(acc, err)
		h.handleBackgroundAccountFailure(acc, err)
		assertAccountNotBanned(t, acc.ID)
	}
	h.handleAccountFailure(acc, errors.New("HTTP 403 from test: forbidden"))
	if got := config.GetAccounts()[0]; got.Enabled || got.BanStatus == "" {
		t.Fatalf("a Kiro 403 no longer bans: enabled=%v ban=%q", got.Enabled, got.BanStatus)
	}
}

// countingDeadProxy accepts each connection and closes it at once, as a broken proxy does,
// and counts the connections.
func countingDeadProxy(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var accepted atomic.Int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			conn.Close()
		}
	}()
	return "http://" + ln.Addr().String(), &accepted
}

// An account's own proxy that fails is dialed once per request: each endpoint and each retry
// of that account dials the same proxy. The request moves to the next account at once, the
// failed pick gives its RPM start back, and the attempt names the first endpoint.
func TestOwnProxyFailureMovesToTheNextAccountAtOnce(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "OK")
	}))
	t.Cleanup(upstream.Close)
	old := kiroEndpoints
	kiroEndpoints = []kiroEndpoint{
		{URL: upstream.URL + "/generateAssistantResponse", Origin: "AI_EDITOR", Name: "first"},
		{URL: upstream.URL + "/generateAssistantResponse", Origin: "AI_EDITOR", Name: "second"},
	}
	t.Cleanup(func() { kiroEndpoints = old })
	if err := config.UpdateEndpointFallback(true); err != nil {
		t.Fatal(err)
	}
	kiroHttpStore.Store(upstream.Client())
	if err := config.AddAccount(config.Account{ID: "next", Enabled: true, AccessToken: "token-next", ProfileArn: "arn:aws:codewhisperer:profile/next"}); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateRoutingMode(config.RoutingModePriority); err != nil {
		t.Fatal(err)
	}
	proxyURL, accepted := countingDeadProxy(t)
	t.Cleanup(func() { proxyClientCache.Delete(proxyURL) })
	acc := setTestAccountProxy(t, h, proxyURL)
	if acc.ID != "only" {
		t.Fatalf("setup: own proxy on %s", acc.ID)
	}
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}
	// The pool is shared: an earlier test's cooldown on this id must not skip the account.
	h.pool.ClearCooldown(acc.ID)
	h.pool.ClearCooldown("next")

	rec := postClientAPI(h, "/v1/messages", transportPlainBody)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "OK") {
		t.Fatalf("status %d %s, want the next account's answer", rec.Code, rec.Body.String())
	}
	if n := accepted.Load(); n != 1 {
		t.Fatalf("the dead proxy was dialed %d times, want once", n)
	}
	if at := h.pool.AtRPMLimit(); at[acc.ID] || !at["next"] {
		t.Fatalf("AtRPMLimit = %v: the dead proxy's pick kept its start, or the answer did not count", at)
	}
	assertAccountNotBanned(t, acc.ID)
}

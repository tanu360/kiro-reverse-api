package proxypool

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// setupPool gives the test its own database and a clean Default manager, with
// the pool on and proxies stored in order. Health checks never leave the machine.
func setupPool(t *testing.T, proxies ...config.PoolProxy) *Manager {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "admin-password")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(SetCheckTargetForTest("http://kiro.test/", nil))
	m := Default()
	m.ResetForTest()
	//! Runs before the check target is restored: it ends this test's background checks first.
	t.Cleanup(m.ResetForTest)
	if err := config.SetProxyPool(proxies); err != nil {
		t.Fatal(err)
	}
	setPoolSettings(t, config.ProxyPoolModeOn, false)
	return m
}

func setPoolSettings(t *testing.T, mode string, fallback bool) {
	t.Helper()
	if err := config.UpdateProxyPoolSettings(&mode, &fallback, nil); err != nil {
		t.Fatal(err)
	}
}

func addAccount(t *testing.T, id, proxyURL string) *config.Account {
	t.Helper()
	acc := config.Account{ID: id, Email: id + "@example.com", Enabled: true, AuthMethod: "social", ProxyURL: proxyURL}
	if err := config.AddAccount(acc); err != nil {
		t.Fatal(err)
	}
	return &acc
}

// closedPortURL is a proxy URL nothing listens on.
func closedPortURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return "http://" + addr
}

// fakeProxy answers every proxied plain-HTTP request itself with status, as if
// it were the upstream behind the proxy.
func fakeProxy(t *testing.T, status int) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		io.WriteString(w, "from upstream")
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func poolProxy(id, rawURL string) config.PoolProxy {
	p, err := buildProxy(ProxyInput{URL: &rawURL}, nil)
	if err != nil {
		panic(err)
	}
	p.ID = id
	return p
}

func strPtr(s string) *string { return &s }

func TestParseInputSplitsCredentials(t *testing.T) {
	p, err := buildProxy(ProxyInput{URL: strPtr(" socks5://alice:p%40ss%3Aword@Proxy.Example.com:1080 "), Label: strPtr("  Tokyo  ")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.URL != "socks5://proxy.example.com:1080" || p.Username != "alice" || p.Password != "p@ss:word" || p.Label != "Tokyo" {
		t.Fatalf("parsed %+v", p)
	}
	u, err := url.Parse(FullURL(p))
	if err != nil {
		t.Fatal(err)
	}
	if pass, _ := u.User.Password(); pass != "p@ss:word" || u.User.Username() != "alice" || u.Host != "proxy.example.com:1080" {
		t.Fatalf("FullURL %q does not round-trip", FullURL(p))
	}
	if DisplayURL(p) != "socks5://proxy.example.com:1080" {
		t.Fatalf("DisplayURL %q", DisplayURL(p))
	}

	v6, err := buildProxy(ProxyInput{URL: strPtr("http://[::1]:8080")}, nil)
	if err != nil || v6.URL != "http://[::1]:8080" {
		t.Fatalf("IPv6: %+v %v", v6, err)
	}

	// Explicit fields win over the URL's userinfo; an edit without a password keeps it.
	edited, err := buildProxy(ProxyInput{URL: strPtr("http://x:y@10.0.0.1:3128"), Username: strPtr("bob")}, &p)
	if err != nil || edited.Username != "bob" || edited.Password != "y" {
		t.Fatalf("edit: %+v %v", edited, err)
	}
	kept, err := buildProxy(ProxyInput{Label: strPtr("Osaka")}, &p)
	if err != nil || kept.Password != "p@ss:word" || kept.URL != p.URL {
		t.Fatalf("label edit changed the proxy: %+v %v", kept, err)
	}
	cleared, err := buildProxy(ProxyInput{Password: strPtr("")}, &p)
	if err != nil || cleared.Password != "" || cleared.Username != "alice" {
		t.Fatalf("clear: %+v %v", cleared, err)
	}
}

func TestParseInputRejectsBadSchemeHostPort(t *testing.T) {
	for _, raw := range []string{
		"",
		"ftp://host:21",
		"127.0.0.1:8080",
		"http://:8080",
		"http://host",
		"http://host:0",
		"http://host:70000",
		"http://host:8080/path",
		"http://host:8080?x=1",
		"socks4://host:1080",
	} {
		_, err := buildProxy(ProxyInput{URL: strPtr(raw)}, nil)
		var inputErr *InputError
		if !errors.As(err, &inputErr) {
			t.Errorf("%q: got %v, want an InputError", raw, err)
		}
	}
	if _, err := buildProxy(ProxyInput{URL: strPtr("http://host:1"), Label: strPtr(strings.Repeat("x", 65))}, nil); err == nil {
		t.Error("a 65-character label was accepted")
	}
	if _, err := buildProxy(ProxyInput{URL: strPtr("http://host:1"), Password: strPtr("secret")}, nil); err == nil {
		t.Error("a password without a username was accepted")
	}
}

func TestResolvePrecedence(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	if err := config.UpdateProxySettings("http://global.example:8080"); err != nil {
		t.Fatal(err)
	}
	own := addAccount(t, "own", "socks5://own.example:1080")
	pooled := addAccount(t, "pooled", "")

	if r := m.Resolve(own); r.Source != SourceAccount || r.URL != "socks5://own.example:1080" {
		t.Fatalf("account proxy: %+v", r)
	}
	if r := m.Resolve(pooled); r.Source != SourcePool || r.ProxyID != "px_a" || r.URL != "http://10.0.0.1:3128" {
		t.Fatalf("pool: %+v", r)
	}
	setPoolSettings(t, config.ProxyPoolModeOff, false)
	if r := m.Resolve(pooled); r.Source != SourceGlobal || r.URL != "http://global.example:8080" {
		t.Fatalf("global: %+v", r)
	}
	if err := config.UpdateProxySettings(""); err != nil {
		t.Fatal(err)
	}
	if r := m.Resolve(pooled); r.Source != SourceDirect || r.URL != "" {
		t.Fatalf("direct: %+v", r)
	}
}

func TestResolveModeOffSkipsPool(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != "px_a" {
		t.Fatalf("mode on: %+v", r)
	}
	setPoolSettings(t, config.ProxyPoolModeOff, false)
	if r := m.Resolve(acc); r.Source != SourceDirect || r.ProxyID != "" {
		t.Fatalf("mode off still used the pool: %+v", r)
	}
	// The assignment survives, so turning the pool back on keeps the account where it was.
	if id, ok := m.Assignment("a1"); !ok || id != "px_a" {
		t.Fatalf("assignment dropped while off: %q %v", id, ok)
	}
}

func TestResolveRoundRobinSticky(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	accounts := []*config.Account{addAccount(t, "a1", ""), addAccount(t, "a2", ""), addAccount(t, "a3", "")}
	want := []string{"px_a", "px_b", "px_a"}
	for i, acc := range accounts {
		if r := m.Resolve(acc); r.ProxyID != want[i] {
			t.Fatalf("%s: got %s, want %s", acc.ID, r.ProxyID, want[i])
		}
	}
	for i := 0; i < 5; i++ {
		for j, acc := range accounts {
			if r := m.Resolve(acc); r.ProxyID != want[j] {
				t.Fatalf("%s moved to %s on request %d", acc.ID, r.ProxyID, i)
			}
		}
	}
	// A failed proxy is skipped for new accounts.
	m.ReportFailure("px_b", &ProxyError{ProxyID: "px_b", Kind: KindConnect, cause: errors.New("refused")})
	if r := m.Resolve(addAccount(t, "a4", "")); r.ProxyID != "px_a" {
		t.Fatalf("new account got %s, want px_a", r.ProxyID)
	}
}

func TestResolveEmptyPoolFallsThrough(t *testing.T) {
	m := setupPool(t)
	if err := config.UpdateProxySettings("http://global.example:8080"); err != nil {
		t.Fatal(err)
	}
	if r := m.Resolve(addAccount(t, "a1", "")); r.Source != SourceGlobal || r.Unavailable {
		t.Fatalf("empty pool: %+v", r)
	}
}

func failAll(m *Manager, ids ...string) {
	for _, id := range ids {
		m.ReportFailure(id, &ProxyError{ProxyID: id, Kind: KindConnect, cause: errors.New("refused")})
	}
}

func TestResolveNoHealthyUnavailable(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	m.mu.Lock()
	m.lastKick = time.Now() // no background check-all from this test
	m.mu.Unlock()
	if err := config.UpdateProxySettings("http://global.example:8080"); err != nil {
		t.Fatal(err)
	}
	acc := addAccount(t, "a1", "")
	failAll(m, "px_a", "px_b")
	r := m.Resolve(acc)
	if !r.Unavailable || r.URL != UnavailableURL {
		t.Fatalf("all failed, no fallback: %+v", r)
	}
	if m.ResolveURL(acc) != UnavailableURL {
		t.Fatal("ResolveURL did not return UnavailableURL")
	}
}

func TestResolveNoHealthyFallbackGlobalThenDirect(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"))
	m.mu.Lock()
	m.lastKick = time.Now() // no background check-all from this test
	m.mu.Unlock()
	setPoolSettings(t, config.ProxyPoolModeOn, true)
	if err := config.UpdateProxySettings("http://global.example:8080"); err != nil {
		t.Fatal(err)
	}
	acc := addAccount(t, "a1", "")
	failAll(m, "px_a")
	if r := m.Resolve(acc); r.Source != SourceFallback || r.URL != "http://global.example:8080" || r.Unavailable {
		t.Fatalf("fallback to global: %+v", r)
	}
	if err := config.UpdateProxySettings(""); err != nil {
		t.Fatal(err)
	}
	if r := m.Resolve(acc); r.Source != SourceFallback || r.URL != "" || r.Unavailable {
		t.Fatalf("fallback to direct: %+v", r)
	}
}

func clientThrough(id, proxyURL string) *http.Client {
	u, _ := url.Parse(proxyURL)
	return &http.Client{Transport: Instrument(id, proxyURL, &http.Transport{Proxy: http.ProxyURL(u)})}
}

func TestInstrumentDialFailureRotatesAccount(t *testing.T) {
	dead := poolProxy("px_dead", closedPortURL(t))
	live := poolProxy("px_live", fakeProxy(t, http.StatusOK))
	m := setupPool(t, dead, live)
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != "px_dead" {
		t.Fatalf("first pick %s, want px_dead", r.ProxyID)
	}

	_, err := clientThrough(dead.ID, FullURL(dead)).Get("http://kiro.test/generate")
	var perr *ProxyError
	if !errors.As(err, &perr) || perr.Kind != KindConnect {
		t.Fatalf("dial failure: %v, want a connect ProxyError", err)
	}
	if h := m.Health("px_dead"); h.Status != StatusFailed || h.FailedAt == 0 || !strings.Contains(h.LastError, "refused") {
		t.Fatalf("dead proxy health %+v", h)
	}
	if id, _ := m.Assignment("a1"); id != "px_live" {
		t.Fatalf("account still on %s", id)
	}

	r := m.Resolve(acc)
	if r.ProxyID != "px_live" {
		t.Fatalf("resolve after failure: %+v", r)
	}
	resp, err := clientThrough(r.ProxyID, r.URL).Get("http://kiro.test/generate")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || m.Health("px_live").Status != StatusOK {
		t.Fatalf("live proxy: status %d, health %+v", resp.StatusCode, m.Health("px_live"))
	}
}

func TestInstrumentIgnoresUpstreamHTTPStatus(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusBadGateway} {
		p := poolProxy("px_a", fakeProxy(t, status))
		m := setupPool(t, p)
		resp, err := clientThrough(p.ID, FullURL(p)).Get("http://kiro.test/generate")
		if err != nil {
			t.Fatalf("%d: %v", status, err)
		}
		resp.Body.Close()
		if resp.StatusCode != status {
			t.Fatalf("status %d, want %d", resp.StatusCode, status)
		}
		if h := m.Health("px_a"); h.Status == StatusFailed {
			t.Fatalf("an upstream %d marked the proxy failed", status)
		}
	}
}

// connectProxy answers every CONNECT with status and every plain request with status too.
func connectProxy(t *testing.T, status int) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status == http.StatusProxyAuthRequired {
			w.Header().Set("Proxy-Authenticate", `Basic realm="pool"`)
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestInstrument407IsAuthFailure(t *testing.T) {
	p := poolProxy("px_auth", connectProxy(t, http.StatusProxyAuthRequired))
	p.Username, p.Password = "bob", "wrong-secret"
	m := setupPool(t, p)

	// HTTPS: the 407 answers the CONNECT, before any connection exists.
	_, err := clientThrough(p.ID, FullURL(p)).Get("https://kiro.test/generate")
	var perr *ProxyError
	if !errors.As(err, &perr) || perr.Kind != KindAuth {
		t.Fatalf("CONNECT 407: %v, want an auth ProxyError", err)
	}
	if h := m.Health(p.ID); h.Status != StatusFailed || strings.Contains(h.LastError, "wrong-secret") {
		t.Fatalf("health %+v", h)
	}

	// Plain HTTP: the 407 arrives as a response.
	m.ResetForTest()
	_, err = clientThrough(p.ID, FullURL(p)).Get("http://kiro.test/generate")
	if !errors.As(err, &perr) || perr.Kind != KindAuth {
		t.Fatalf("plain 407: %v, want an auth ProxyError", err)
	}

	// A CONNECT refused with 403 is the tunnel, not the account.
	q := poolProxy("px_tunnel", connectProxy(t, http.StatusForbidden))
	if err := config.SetProxyPool([]config.PoolProxy{p, q}); err != nil {
		t.Fatal(err)
	}
	_, err = clientThrough(q.ID, FullURL(q)).Get("https://kiro.test/generate")
	if !errors.As(err, &perr) || perr.Kind != KindTunnel {
		t.Fatalf("CONNECT 403: %v, want a tunnel ProxyError", err)
	}
}

func TestInstrumentIgnoresContextCancel(t *testing.T) {
	// A proxy that accepts the connection and never answers the CONNECT.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = bufio.NewReader(conn).ReadString('\n')
				time.Sleep(2 * time.Second)
			}()
		}
	}()
	p := poolProxy("px_slow", "http://"+ln.Addr().String())
	m := setupPool(t, p)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://kiro.test/generate", nil)
	_, err = clientThrough(p.ID, FullURL(p)).Do(req)
	if err == nil {
		t.Fatal("expected the canceled request to fail")
	}
	if IsProxyError(err) {
		t.Fatalf("a canceled request became a ProxyError: %v", err)
	}
	if h := m.Health(p.ID); h.Status == StatusFailed {
		t.Fatalf("a canceled request marked the proxy failed: %+v", h)
	}
}

func TestCheckProxyHealthyRecordsLatency(t *testing.T) {
	p := poolProxy("px_ok", fakeProxy(t, http.StatusForbidden))
	m := setupPool(t, p)
	h, err := m.CheckOne(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if h.Status != StatusOK || h.LatencyMs < 1 || h.CheckedAt == 0 {
		t.Fatalf("health %+v, want ok with a latency", h)
	}
	if _, err := m.CheckOne(context.Background(), "px_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown proxy: %v", err)
	}
}

func TestCheckProxyClosedPortFails(t *testing.T) {
	p := poolProxy("px_dead", closedPortURL(t))
	p.Username, p.Password = "carol", "hunter2-secret"
	m := setupPool(t, p, poolProxy("px_other", "http://10.0.0.9:3128"))
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != "px_dead" {
		t.Fatalf("first pick %s", r.ProxyID)
	}
	h, err := m.CheckOne(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if h.Status != StatusFailed || h.CheckedAt == 0 || h.LastError == "" {
		t.Fatalf("health %+v, want failed", h)
	}
	if strings.Contains(h.LastError, "hunter2") {
		t.Fatalf("lastError leaks the password: %q", h.LastError)
	}
	if id, _ := m.Assignment("a1"); id != "px_other" {
		t.Fatalf("a failed check left the account on %s", id)
	}
}

func TestProxyErrorTextAvoidsBanKeywords(t *testing.T) {
	banned := []string{"forbidden", "unauthorized", "authentication failed", "quota", "429", "402", "suspended", "token", "http 40", "no available kiro profile"}
	for _, kind := range []string{KindDNS, KindConnect, KindTimeout, KindTLS, KindAuth, KindTunnel, KindSOCKS, KindNoHealthy} {
		text := strings.ToLower((&ProxyError{ProxyID: "px_429", Kind: kind, cause: errors.New("socks connect: username/password authentication failed: 403 Forbidden")}).Error())
		for _, word := range banned {
			if strings.Contains(text, word) {
				t.Errorf("%s: %q contains %q", kind, text, word)
			}
		}
	}
	if !IsNoHealthy(NoHealthyError()) || !errors.Is(NoHealthyError(), ErrNoHealthyProxy) {
		t.Fatal("NoHealthyError is not recognized")
	}
}

func TestRedactNeverLeaksPassword(t *testing.T) {
	p := config.PoolProxy{URL: "http://h:1", Username: "bob", Password: "s3cr@t/pw"}
	full := FullURL(p)
	text := Redact("dial "+full+" failed; raw s3cr@t/pw; escaped "+url.QueryEscape(p.Password)+"; other http://x:y@z:2", p)
	if strings.Contains(text, "s3cr") || strings.Contains(text, "x:y@") {
		t.Fatalf("redacted text still holds a secret: %q", text)
	}
	long := Redact(strings.Repeat("e", 1000), p)
	if n := len([]rune(long)); n > maxErrorRunes {
		t.Fatalf("redacted text is %d runes", n)
	}
}

func TestStatePersistsAcrossReload(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	acc := addAccount(t, "a1", "")
	addAccount(t, "gone", "")
	m.Resolve(acc)
	m.Resolve(&config.Account{ID: "gone"})
	failAll(m, "px_a")
	if err := config.DeleteAccount("gone"); err != nil {
		t.Fatal(err)
	}
	m.Flush()

	m.ResetForTest()
	if id, ok := m.Assignment("a1"); !ok || id != "px_b" {
		t.Fatalf("assignment after reload: %q %v", id, ok)
	}
	if h := m.Health("px_a"); h.Status != StatusFailed || h.LastError == "" {
		t.Fatalf("health after reload: %+v", h)
	}
	if _, ok := m.Assignment("gone"); ok {
		t.Fatal("a deleted account's assignment was kept")
	}
}

func TestResolveFallbackStartsARecoveryCheck(t *testing.T) {
	p := poolProxy("px_a", fakeProxy(t, http.StatusOK))
	m := setupPool(t, p)
	setPoolSettings(t, config.ProxyPoolModeOn, true)
	acc := addAccount(t, "a1", "")
	failAll(m, p.ID)
	if r := m.Resolve(acc); r.Source != SourceFallback {
		t.Fatalf("all failed with fallback: %+v", r)
	}
	// No periodic check runs here: only the fallback's own kick can bring the proxy back.
	deadline := time.Now().Add(5 * time.Second)
	for m.Health(p.ID).Status != StatusOK {
		if time.Now().After(deadline) {
			t.Fatal("a fallback route started no recovery check")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if r := m.Resolve(acc); r.Source != SourcePool || r.ProxyID != p.ID {
		t.Fatalf("route after the recovery: %+v", r)
	}
}

// stallingProxy accepts every connection, reads what the client sends and never
// answers. closed receives once for each connection the client closes.
func stallingProxy(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{}, 16)
	conns := make(chan net.Conn, 16)
	t.Cleanup(func() {
		ln.Close()
		for {
			select {
			case c := <-conns:
				c.Close()
			default:
				return
			}
		}
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			select {
			case conns <- conn:
			default:
			}
			go func() {
				_, _ = io.Copy(io.Discard, conn)
				conn.Close()
				select {
				case closed <- struct{}{}:
				default:
				}
			}()
		}
	}()
	return ln.Addr().String(), closed
}

func TestInstrumentStalledSOCKSHandshakeTimesOut(t *testing.T) {
	addr, closed := stallingProxy(t)
	stalled := poolProxy("px_stalled", "socks5://"+addr)
	live := poolProxy("px_live", fakeProxy(t, http.StatusOK))
	m := setupPool(t, stalled, live)
	prev := connectTimeout
	connectTimeout = 300 * time.Millisecond
	t.Cleanup(func() { connectTimeout = prev })
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != stalled.ID {
		t.Fatalf("first pick %s, want %s", r.ProxyID, stalled.ID)
	}

	// No deadline on the request and no timeout in the transport: only the connect timer ends it.
	start := time.Now()
	_, err := clientThrough(stalled.ID, FullURL(stalled)).Get("https://kiro.test/generate")
	var perr *ProxyError
	if !errors.As(err, &perr) || perr.Kind != KindTimeout {
		t.Fatalf("stalled SOCKS handshake: %v, want a timeout ProxyError", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the stalled request took %s", took)
	}
	if h := m.Health(stalled.ID); h.Status != StatusFailed || !strings.Contains(h.LastError, "timed out") {
		t.Fatalf("stalled proxy health %+v", h)
	}
	if id, _ := m.Assignment("a1"); id != live.ID {
		t.Fatalf("account still on %s", id)
	}
	// Go keeps dialing after the request gives up; the transport ends that dial too.
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the stalled SOCKS dial was left running")
	}
}

func TestReportsAboutAnEditedProxyAreDropped(t *testing.T) {
	old := poolProxy("px_a", closedPortURL(t))
	other := poolProxy("px_b", fakeProxy(t, http.StatusOK))
	m := setupPool(t, old, other)
	acc := addAccount(t, "a1", "")
	if r := m.Resolve(acc); r.ProxyID != old.ID {
		t.Fatalf("first pick %s", r.ProxyID)
	}
	m.mu.Lock()
	gen := m.gen
	m.mu.Unlock()
	client := clientThrough(old.ID, FullURL(old))

	// The admin corrects the address while a request and a check still use the old one.
	fixed := old
	fixed.URL = fakeProxy(t, http.StatusOK)
	if err := config.SetProxyPool([]config.PoolProxy{fixed, other}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get("http://kiro.test/generate"); !IsProxyError(err) {
		t.Fatalf("old client: %v, want a ProxyError", err)
	}
	m.recordCheck(gen, old, 0, &ProxyError{Kind: KindTimeout, cause: errors.New("timed out")})
	if h := m.Health(old.ID); h.Status == StatusFailed {
		t.Fatalf("a result for the old address marked the edited proxy failed: %+v", h)
	}
	if id, _ := m.Assignment("a1"); id != old.ID {
		t.Fatalf("a result for the old address moved the account to %s", id)
	}

	// A report about the current address still counts.
	m.reportFailure(fixed.ID, FullURL(fixed), &ProxyError{Kind: KindConnect, cause: errors.New("refused")})
	if h := m.Health(fixed.ID); h.Status != StatusFailed {
		t.Fatalf("a current report was dropped: %+v", h)
	}
}

func TestResetForTestEndsBackgroundChecks(t *testing.T) {
	addr, _ := stallingProxy(t)
	p := poolProxy("px_stall", "http://"+addr)
	m := setupPool(t, p)
	m.checkSoon(p.ID)
	m.StartCheckAll()

	start := time.Now()
	m.ResetForTest()
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("ResetForTest took %s", took)
	}
	m.mu.Lock()
	running := m.bgRunning
	m.mu.Unlock()
	if running != 0 {
		t.Fatalf("%d background checks outlived ResetForTest", running)
	}
	if h := m.Health(p.ID); h.Status != StatusUnknown {
		t.Fatalf("a canceled check was recorded: %+v", h)
	}
}

func TestStateLoadIsRetriedAfterAFailedRead(t *testing.T) {
	m := setupPool(t, poolProxy("px_a", "http://10.0.0.1:3128"), poolProxy("px_b", "http://10.0.0.2:3128"))
	a1 := addAccount(t, "a1", "")
	a2 := addAccount(t, "a2", "")
	failAll(m, "px_a")
	if r := m.Resolve(a1); r.ProxyID != "px_b" {
		t.Fatalf("a1 on %s", r.ProxyID)
	}
	m.Flush()
	m.ResetForTest()

	// The database cannot be read: a file sits where its directory should be.
	dir := db.DataDir()
	blocker := t.TempDir() + "/file"
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = db.Init(blocker + "/db")
	t.Cleanup(func() {
		_ = db.Close()
		_ = db.Init(dir)
	})
	if _, ok := m.Assignment("a1"); ok {
		t.Fatal("an assignment came from an unreadable database")
	}
	if r := m.Resolve(a2); r.ProxyID != "px_a" {
		t.Fatalf("a2 on %s", r.ProxyID)
	}

	// Once the database is back, the saved state is read and what changed meanwhile is kept.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.Init(dir); err != nil {
		t.Fatal(err)
	}
	if id, ok := m.Assignment("a1"); !ok || id != "px_b" {
		t.Fatalf("a1 after the retry: %q %v", id, ok)
	}
	if id, _ := m.Assignment("a2"); id != "px_a" {
		t.Fatalf("a2 after the retry: %q", id)
	}
	if h := m.Health("px_a"); h.Status != StatusFailed {
		t.Fatalf("saved health was not read: %+v", h)
	}
}

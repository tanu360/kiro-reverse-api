package proxy

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/proxypool"
)

// clearOnlyCooldown lifts the cooldown the failures of a test left on the stream
// test handler's account: the account pool outlives the test.
func clearOnlyCooldown(t *testing.T, h *Handler) {
	t.Helper()
	h.pool.ClearCooldown("only")
	t.Cleanup(func() { h.pool.ClearCooldown("only") })
}

// lastRecordedRequest is the newest request log row.
func lastRecordedRequest(t *testing.T) requestRecord {
	t.Helper()
	recs := getObserveStore().RecentRequests(1)
	if len(recs) != 1 {
		t.Fatalf("expected one recorded request, got %d", len(recs))
	}
	return recs[0]
}

// assertNoGoText fails when a request log text repeats Kiro's URL, the proxy's
// address or Go's own error wording.
func assertNoGoText(t *testing.T, where, text string, leaks ...string) {
	t.Helper()
	for _, leak := range append([]string{"https://", "http://", "proxyconnect", "dial tcp", "socks connect", "Post \""}, leaks...) {
		if strings.Contains(text, leak) {
			t.Errorf("%s holds %q: %s", where, leak, text)
		}
	}
}

// socksRejectingLogin is a SOCKS5 proxy that asks for a username and password and
// rejects every one.
func socksRejectingLogin(t *testing.T) string {
	t.Helper()
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
			go func(conn net.Conn) {
				defer conn.Close()
				head := make([]byte, 2)
				if _, err := io.ReadFull(conn, head); err != nil {
					return
				}
				if _, err := io.ReadFull(conn, make([]byte, head[1])); err != nil {
					return
				}
				_, _ = conn.Write([]byte{5, 2})
				ver := make([]byte, 2)
				if _, err := io.ReadFull(conn, ver); err != nil {
					return
				}
				if _, err := io.ReadFull(conn, make([]byte, ver[1])); err != nil {
					return
				}
				plen := make([]byte, 1)
				if _, err := io.ReadFull(conn, plen); err != nil {
					return
				}
				if _, err := io.ReadFull(conn, make([]byte, plen[0])); err != nil {
					return
				}
				_, _ = conn.Write([]byte{1, 1})
			}(conn)
		}
	}()
	return ln.Addr().String()
}

// A try that failed at an outbound proxy is logged as a "proxy" failure, row and
// attempt alike, with the client's wording and where the proxy came from. Go's
// text, Kiro's URL and the proxy's address stay out of the request log.
func TestProxyFailuresLogAsProxyErrors(t *testing.T) {
	refusing := func(status int) string {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "denied", status)
		}))
		t.Cleanup(srv.Close)
		return srv.URL
	}
	answering := func(statusLine string) string {
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
				go func(conn net.Conn) {
					defer conn.Close()
					if _, err := http.ReadRequest(bufio.NewReader(conn)); err == nil {
						_, _ = io.WriteString(conn, "HTTP/1.1 "+statusLine+"\r\nContent-Length: 0\r\n\r\n")
					}
				}(conn)
			}
		}()
		return "http://" + ln.Addr().String()
	}
	closed := "http://" + poolClosedPort(t)
	cases := []struct {
		name     string
		own      string
		global   string
		want     attemptProxyFailure
		wantText string
	}{
		{"own refused", closed, "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindConnect}, "outbound proxy failed: connection refused or reset"},
		{"own CONNECT 403", refusing(http.StatusForbidden), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindTunnel, Status: 403}, "outbound proxy failed: proxy refused the tunnel"},
		{"own CONNECT 407 without a login", refusing(http.StatusProxyAuthRequired), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindAuthRequired, Status: 407}, "outbound proxy failed: proxy requires a sign-in"},
		{"own CONNECT 407 with a login", strings.Replace(refusing(http.StatusProxyAuthRequired), "http://", "http://user:wrong@", 1), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindAuth, Status: 407}, "outbound proxy failed: proxy rejected the sign-in"},
		{"own CONNECT 403 own phrase", answering("403 Access violation"), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindTunnel, Status: 403}, "outbound proxy failed: proxy refused the tunnel"},
		{"own SOCKS login", "socks5://user:wrong@" + socksRejectingLogin(t), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindAuth}, "outbound proxy failed: proxy rejected the sign-in"},
		{"own SOCKS refused", "socks5://" + poolClosedPort(t), "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindConnect}, "outbound proxy failed: connection refused or reset"},
		{"own host unknown", "http://proxy.invalid:3128", "", attemptProxyFailure{Source: proxySourceAccount, Code: proxypool.KindDNS}, "outbound proxy failed: proxy host lookup failed"},
		{"global refused", "", closed, attemptProxyFailure{Source: proxySourceGlobal, Code: proxypool.KindConnect}, "outbound proxy failed: connection refused or reset"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("a request reached Kiro past a failed proxy") })
			clearOnlyCooldown(t, h)
			kiroEndpoints = []kiroEndpoint{{URL: "https://kiro.invalid/generateAssistantResponse", Origin: "AI_EDITOR", Name: "test"}}
			if err := config.UpdateProxySettings(c.global); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				proxyClientCache.Delete(c.own)
				proxyClientCache.Delete(c.global)
			})
			acc := setTestAccountProxy(t, h, c.own)

			if rec := postClientAPI(h, "/v1/messages", transportPlainBody); rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status %d %s, want 503", rec.Code, rec.Body.String())
			}
			row := lastRecordedRequest(t)
			if row.ErrorType != errorTypeProxy || row.Message != c.wantText || row.Status != http.StatusServiceUnavailable {
				t.Fatalf("row = %q %d %q, want proxy 503 %q", row.ErrorType, row.Status, row.Message, c.wantText)
			}
			if len(row.Attempts) != 1 {
				t.Fatalf("attempts = %#v, want one", row.Attempts)
			}
			a := row.Attempts[0]
			if a.Success || a.ErrorType != errorTypeProxy || a.Message != c.wantText || a.Proxy == nil || *a.Proxy != c.want {
				t.Fatalf("attempt = %+v proxy %+v, want proxy %+v %q", a, a.Proxy, c.want, c.wantText)
			}
			if a.Status != 0 {
				t.Fatalf("attempt status %d: the proxy's answer is not Kiro's", a.Status)
			}
			assertNoGoText(t, "row message", row.Message, "kiro.invalid", "127.0.0.1", "wrong")
			assertNoGoText(t, "attempt message", a.Message, "kiro.invalid", "127.0.0.1", "wrong")
			assertAccountNotBanned(t, acc.ID)
		})
	}
}

// An own or the global proxy whose URL is also in the pool stays an own or the
// global proxy: with the pool off, its failure is not the pool's, so the request
// fails over at once instead of retrying the account, and the pool proxy's health
// is left alone.
func TestProxyListedInPoolKeepsItsSource(t *testing.T) {
	for _, c := range []struct {
		name   string
		own    bool
		source string
	}{
		{"global", false, proxySourceGlobal},
		{"own", true, proxySourceAccount},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("a request reached Kiro past a failed proxy") })
			clearOnlyCooldown(t, h)
			kiroEndpoints = []kiroEndpoint{{URL: "https://kiro.invalid/generateAssistantResponse", Origin: "AI_EDITOR", Name: "test"}}
			t.Cleanup(proxypool.SetCheckTargetForTest("http://kiro.test/", nil))
			proxypool.Default().ResetForTest()
			t.Cleanup(proxypool.Default().ResetForTest)
			t.Cleanup(dropPoolClients)
			listed := "http://" + poolClosedPort(t)
			if err := config.SetProxyPool([]config.PoolProxy{{ID: "px_listed", URL: listed}}); err != nil {
				t.Fatal(err)
			}
			setPoolMode(t, config.ProxyPoolModeOff, false)
			global := ""
			if !c.own {
				global = listed
			}
			if err := config.UpdateProxySettings(global); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = config.UpdateProxySettings("")
				proxyClientCache.Delete(listed)
			})
			own := ""
			if c.own {
				own = listed
			}
			setTestAccountProxy(t, h, own)

			postClientAPI(h, "/v1/messages", transportPlainBody)
			row := lastRecordedRequest(t)
			if row.ErrorType != errorTypeProxy || row.Message != "outbound proxy failed: connection refused or reset" {
				t.Fatalf("row = %q %q, want the %s proxy's wording", row.ErrorType, row.Message, c.source)
			}
			want := attemptProxyFailure{Source: c.source, Code: proxypool.KindConnect}
			if len(row.Attempts) != 1 || row.Attempts[0].Proxy == nil || *row.Attempts[0].Proxy != want {
				t.Fatalf("attempts = %#v, want one %+v", row.Attempts, want)
			}
			if h := proxypool.Default().Health("px_listed"); h.Status == proxypool.StatusFailed {
				t.Fatalf("the pool proxy was marked failed: %+v", h)
			}
		})
	}
}

// With no healthy pool proxy, the try is a pool proxy failure.
func TestNoHealthyPoolLogsAsProxyError(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a request reached Kiro without a healthy pool proxy")
	})
	clearOnlyCooldown(t, h)
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
	h.pool.Reload()

	if rec := postClientAPI(h, "/v1/messages", transportPlainBody); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d %s, want 503", rec.Code, rec.Body.String())
	}
	row := lastRecordedRequest(t)
	want := attemptProxyFailure{Source: proxySourcePool, Code: proxypool.KindNoHealthy}
	if row.ErrorType != errorTypeProxy || row.Message != proxypool.ErrNoHealthyProxy.Error() {
		t.Fatalf("row = %q %q, want a proxy row", row.ErrorType, row.Message)
	}
	if len(row.Attempts) != 1 || row.Attempts[0].Proxy == nil || *row.Attempts[0].Proxy != want {
		t.Fatalf("attempts = %#v, want one no-healthy pool failure", row.Attempts)
	}
}

// A pool proxy that refuses the connection is a pool proxy failure.
func TestPoolProxyRefusedLogsAsProxyError(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) { t.Error("a request reached Kiro past a dead pool proxy") })
	clearOnlyCooldown(t, h)
	t.Cleanup(proxypool.SetCheckTargetForTest("http://kiro.test/", nil))
	proxypool.Default().ResetForTest()
	t.Cleanup(proxypool.Default().ResetForTest)
	t.Cleanup(dropPoolClients)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t)}
	if err := config.SetProxyPool([]config.PoolProxy{dead}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	h.pool.Reload()

	postClientAPI(h, "/v1/messages", transportPlainBody)
	row := lastRecordedRequest(t)
	if row.ErrorType != errorTypeProxy || len(row.Attempts) == 0 {
		t.Fatalf("row = %q %#v, want a proxy row with attempts", row.ErrorType, row.Attempts)
	}
	first := row.Attempts[0]
	want := attemptProxyFailure{Source: proxySourcePool, Code: proxypool.KindConnect}
	if first.Proxy == nil || *first.Proxy != want || first.Message != "outbound pool proxy failed: connection refused or reset" {
		t.Fatalf("attempt = %+v proxy %+v, want %+v", first, first.Proxy, want)
	}
}

// Proxy texts that reach the log as strings only are "proxy", never "auth": a
// proxy's "authentication failed" or "Forbidden" says nothing about the token.
func TestClassifyProxyFailureMessages(t *testing.T) {
	for _, message := range []string{
		"no healthy outbound proxy in the pool",
		"outbound pool proxy failed: proxy rejected the sign-in",
		"outbound proxy failed: proxy refused the tunnel",
		`Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`,
		`Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": socks connect tcp 127.0.0.1:1080->q.us-east-1.amazonaws.com:443: username/password authentication failed`,
		`Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": Forbidden`,
		`Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": no connection through the proxy within 15s`,
	} {
		if got := classifyRequestError(false, http.StatusServiceUnavailable, message); got != errorTypeProxy {
			t.Errorf("classifyRequestError(%q) = %q, want proxy", message, got)
		}
	}
	for message, want := range map[string]string{
		"HTTP 403 from test: forbidden":      "auth",
		"HTTP 403: Forbidden":                "auth",
		"upstream connection failed":         "upstream",
		"Forbidden":                          "auth",
		"Post \"https://kiro.invalid\": EOF": "upstream",
	} {
		if got := classifyRequestError(false, http.StatusInternalServerError, message); got != want {
			t.Errorf("classifyRequestError(%q) = %q, want %q", message, got, want)
		}
	}
}

// Rows logged before attempts named their proxy failure read back with the
// client's wording and the "proxy" type, and their failed attempts gain the
// failure for the UI.
func TestTidyLoggedProxyFailures(t *testing.T) {
	const url = `Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": `
	cases := []struct {
		message string
		clean   string
		want    attemptProxyFailure
	}{
		{url + "proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused", "outbound proxy failed: connection refused or reset", attemptProxyFailure{Code: proxypool.KindConnect}},
		{url + "proxyconnect tcp: dial tcp: lookup proxy.invalid: no such host", "outbound proxy failed: proxy host lookup failed", attemptProxyFailure{Code: proxypool.KindDNS}},
		{url + "proxyconnect tcp: dial tcp 10.0.0.1:3128: i/o timeout", "outbound proxy failed: connection timed out", attemptProxyFailure{Code: proxypool.KindTimeout}},
		{url + "socks connect tcp 127.0.0.1:1080->q.us-east-1.amazonaws.com:443: username/password authentication failed", "outbound proxy failed: proxy rejected the sign-in", attemptProxyFailure{Code: proxypool.KindAuth}},
		{url + "socks connect tcp 127.0.0.1:1080->q.us-east-1.amazonaws.com:443: dial tcp 127.0.0.1:1080: connect: connection refused", "outbound proxy failed: connection refused or reset", attemptProxyFailure{Code: proxypool.KindConnect}},
		{"Web search failed: outbound proxy failed: connection timed out", "Web search failed: outbound proxy failed: connection timed out", attemptProxyFailure{Code: proxypool.KindTimeout}},
		{url + "Forbidden", "outbound proxy failed: proxy refused the tunnel", attemptProxyFailure{Code: proxypool.KindTunnel, Status: 403}},
		{url + "Proxy Authentication Required", "outbound proxy failed: proxy rejected the sign-in", attemptProxyFailure{Code: proxypool.KindAuth, Status: 407}},
		{url + "Bad Gateway", "outbound proxy failed: proxy refused the tunnel", attemptProxyFailure{Code: proxypool.KindTunnel, Status: 502}},
		{url + "no connection through the proxy within 15s", "outbound proxy failed: connection timed out", attemptProxyFailure{Code: proxypool.KindTimeout}},
		{url + "proxy connect timeout: no connection within 15s", "outbound proxy failed: connection timed out", attemptProxyFailure{Code: proxypool.KindTimeout}},
		{url + "socks connect tcp 127.0.0.1:1080->q.us-east-1.amazonaws.com:443: no acceptable authentication methods", "outbound proxy failed: proxy requires a sign-in", attemptProxyFailure{Code: proxypool.KindAuthRequired}},
		{"outbound pool proxy failed: TLS handshake failed", "outbound pool proxy failed: TLS handshake failed", attemptProxyFailure{Source: proxySourcePool, Code: proxypool.KindTLS}},
		{"no healthy outbound proxy in the pool", "no healthy outbound proxy in the pool", attemptProxyFailure{Source: proxySourcePool, Code: proxypool.KindNoHealthy}},
	}
	for _, c := range cases {
		rec := requestRecord{
			Message:   c.message,
			ErrorType: "upstream",
			Attempts: []requestAttempt{
				{AccountID: "a", ErrorType: "upstream", Message: c.message},
				{AccountID: "b", ErrorType: "upstream", Message: "HTTP 500 from test: boom"},
				{AccountID: "c", Success: true},
			},
		}
		tidyLoggedProxyFailures(&rec)
		if rec.Message != c.clean || rec.ErrorType != errorTypeProxy {
			t.Errorf("%q: row = %q %q, want proxy %q", c.message, rec.ErrorType, rec.Message, c.clean)
		}
		a := rec.Attempts[0]
		if a.Message != c.clean || a.ErrorType != errorTypeProxy || a.Proxy == nil || *a.Proxy != c.want {
			t.Errorf("%q: attempt = %+v proxy %+v, want %+v", c.message, a, a.Proxy, c.want)
		}
		if other := rec.Attempts[1]; other.Proxy != nil || other.ErrorType != "upstream" || other.Message != "HTTP 500 from test: boom" {
			t.Errorf("%q: a Kiro failure changed: %+v", c.message, other)
		}
	}

	// A Kiro 403 and a succeeded row's message stay as they are.
	kiro := requestRecord{Message: "HTTP 403 from test: Forbidden", Attempts: []requestAttempt{{Message: "HTTP 403 from test: Forbidden"}}}
	before := kiro
	before.Attempts = append([]requestAttempt(nil), kiro.Attempts...)
	tidyLoggedProxyFailures(&kiro)
	ok := requestRecord{Success: true, Message: `Post "https://x": Forbidden`}
	tidyLoggedProxyFailures(&ok)
	if !reflect.DeepEqual(kiro, before) || ok.Message != `Post "https://x": Forbidden` {
		t.Fatalf("tidy changed rows that were no proxy failures: %+v %+v", kiro, ok)
	}
}

// A row read back from the database is tidied.
func TestLoggedProxyFailureTidiedOnRead(t *testing.T) {
	newObserveStoreForTest(t)
	raw := `Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`
	rec := requestRecord{TS: 1, AccountID: "a", Model: "m", Status: 503, Message: raw, ErrorType: "upstream",
		Attempts: []requestAttempt{{AccountID: "a", ErrorType: "upstream", Message: raw}}}
	if err := persistRequestRecord(rec); err != nil {
		t.Fatal(err)
	}
	page, err := queryPersistedRequests(requestQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Requests) != 1 {
		t.Fatalf("rows = %d", len(page.Requests))
	}
	got := page.Requests[0]
	if got.Message != "outbound proxy failed: connection refused or reset" || got.ErrorType != errorTypeProxy {
		t.Fatalf("row = %q %q", got.ErrorType, got.Message)
	}
	if len(got.Attempts) != 1 || got.Attempts[0].Proxy == nil || got.Attempts[0].Proxy.Code != proxypool.KindConnect {
		t.Fatalf("attempts = %#v", got.Attempts)
	}
}

// Rows logged as "upstream" or "auth" before the proxy type existed are filed under it on
// start, so the request log's exact "Proxy error" filter finds them too.
func TestReclassifyStoredProxyFailures(t *testing.T) {
	setupApiKeyUsageTest(t)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	insert := func(ts int64, success int, status int, errorType, message string) {
		if _, err := d.Exec(`INSERT INTO requests (ts, success, status, error_type, message) VALUES (?, ?, ?, ?, ?)`, ts, success, status, errorType, message); err != nil {
			t.Fatal(err)
		}
	}
	insert(1, 0, 503, "upstream", `Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`)
	insert(2, 0, 400, "auth", `Post "https://q.us-east-1.amazonaws.com/generateAssistantResponse": Forbidden`)
	insert(3, 0, 500, "upstream", "upstream connection failed: the proxy stalled")
	insert(4, 1, 200, "", "")
	for run := 0; run < 2; run++ {
		if err := reclassifyStoredProxyFailures(); err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
	}
	rows, err := d.Query(`SELECT error_type FROM requests ORDER BY ts`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var errorType string
		if err := rows.Scan(&errorType); err != nil {
			t.Fatal(err)
		}
		got = append(got, errorType)
	}
	if strings.Join(got, ",") != "proxy,proxy,upstream," {
		t.Fatalf("error types = %q", got)
	}
	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10, ErrorType: "proxy"})
	if page.Total != 2 {
		t.Fatalf("proxy filter found %d rows, want 2", page.Total)
	}
}

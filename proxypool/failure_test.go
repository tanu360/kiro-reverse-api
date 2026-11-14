package proxypool

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

// connectRefusingProxy answers every CONNECT with status.
func connectRefusingProxy(t *testing.T, status int) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "denied", status)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
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

// connectAnsweringProxy answers every CONNECT with statusLine as it is, such as a
// reason phrase of the proxy's own ("403 Access violation").
func connectAnsweringProxy(t *testing.T, statusLine string) string {
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
				if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
					return
				}
				_, _ = io.WriteString(conn, "HTTP/1.1 "+statusLine+"\r\nContent-Length: 0\r\n\r\n")
			}(conn)
		}
	}()
	return "http://" + ln.Addr().String()
}

// A failed check stores the failure's kind and the proxy's answer to CONNECT
// beside the redacted text, for the admin UI's own wording; a good check clears them.
func TestCheckStoresFailureCode(t *testing.T) {
	oneStrike(t)
	closed := closedPortURL(t)
	cases := []struct {
		name   string
		url    string
		code   string
		status int
	}{
		{"refused", closed, KindConnect, 0},
		{"socks refused", "socks5://" + strings.TrimPrefix(closed, "http://"), KindConnect, 0},
		{"connect 403", connectRefusingProxy(t, http.StatusForbidden), KindTunnel, http.StatusForbidden},
		{"connect 502", connectRefusingProxy(t, http.StatusBadGateway), KindTunnel, http.StatusBadGateway},
		{"connect 407 without a login", connectRefusingProxy(t, http.StatusProxyAuthRequired), KindAuthRequired, http.StatusProxyAuthRequired},
		{"connect 407 with a login", strings.Replace(connectRefusingProxy(t, http.StatusProxyAuthRequired), "http://", "http://user:wrong-secret@", 1), KindAuth, http.StatusProxyAuthRequired},
		{"connect 403 own phrase", connectAnsweringProxy(t, "403 Access violation"), KindTunnel, http.StatusForbidden},
		{"connect 502 own phrase", connectAnsweringProxy(t, "502 Proxy Error"), KindTunnel, http.StatusBadGateway},
		{"socks login", "socks5://user:wrong-secret@" + socksRejectingLogin(t), KindAuth, 0},
		{"unknown host", "http://proxy.invalid:3128", KindDNS, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := poolProxy("px_case", c.url)
			m := setupPool(t, p)
			//! An https target makes the check open a CONNECT tunnel, as it does against Kiro.
			t.Cleanup(SetCheckTargetForTest("https://kiro.test/", nil))
			h, err := m.CheckOne(context.Background(), p.ID)
			if err != nil {
				t.Fatal(err)
			}
			if h.Status != StatusFailed || h.ErrorCode != c.code || h.ErrorStatus != c.status {
				t.Fatalf("health %+v, want failed %s %d", h, c.code, c.status)
			}
			if strings.Contains(h.LastError, "wrong-secret") {
				t.Fatalf("lastError leaks the password: %q", h.LastError)
			}
		})
	}
}

func TestGoodCheckClearsFailureCode(t *testing.T) {
	live := poolProxy("px_live", fakeProxy(t, http.StatusOK))
	m := setupPool(t, live)
	m.ReportFailure(live.ID, &ProxyError{ProxyID: live.ID, Kind: KindTunnel, cause: io.EOF})
	if h := m.Health(live.ID); h.ErrorCode != KindTunnel {
		t.Fatalf("after a failure %+v", h)
	}
	if h, _ := m.CheckOne(context.Background(), live.ID); h.Status != StatusOK || h.ErrorCode != "" || h.ErrorStatus != 0 {
		t.Fatalf("after a good check %+v, want no failure code", h)
	}
}

// A last error saved before Health had ErrorCode reads back with its code.
func TestSavedLastErrorGainsCode(t *testing.T) {
	m := setupPool(t,
		poolProxy("px_a", "http://10.0.0.1:3128"),
		poolProxy("px_b", "http://10.0.0.2:3128"),
		poolProxy("px_c", "http://10.0.0.3:3128"),
		poolProxy("px_d", "http://10.0.0.4:3128"))
	saved := `{"health":{
		"px_a":{"status":"failed","lastError":"connection timed out: context deadline exceeded"},
		"px_b":{"status":"failed","lastError":"proxy refused the tunnel: Forbidden"},
		"px_c":{"status":"failed","lastError":"proxy rejected the sign-in: 407 Proxy Authentication Required"},
		"px_d":{"status":"failed","lastError":"something new: boom"}}}`
	if err := config.SaveProxyPoolState(saved); err != nil {
		t.Fatal(err)
	}
	m.ResetForTest()
	for id, want := range map[string]Failure{
		"px_a": {Kind: KindTimeout},
		"px_b": {Kind: KindTunnel, Status: http.StatusForbidden},
		"px_c": {Kind: KindAuth, Status: http.StatusProxyAuthRequired},
		"px_d": {},
	} {
		if h := m.Health(id); h.ErrorCode != want.Kind || h.ErrorStatus != want.Status || h.LastError == "" {
			t.Errorf("%s: %+v, want %+v", id, h, want)
		}
	}
}

// The server log gets a pool proxy failure's cause without the proxy's password;
// any other error reads as it is.
func TestLogTextAddsRedactedCause(t *testing.T) {
	p := poolProxy("px_log", "http://user:hunter2-secret@10.0.0.1:3128")
	setupPool(t, p)
	err := &ProxyError{ProxyID: p.ID, Kind: KindTunnel, cause: errors.New("Access violation from user:hunter2-secret@10.0.0.1")}
	got := LogText(err)
	if !strings.Contains(got, "outbound pool proxy failed: proxy refused the tunnel (") || !strings.Contains(got, "Access violation") {
		t.Fatalf("LogText = %q, want the wording and the cause", got)
	}
	if strings.Contains(got, "hunter2-secret") {
		t.Fatalf("LogText leaks the password: %q", got)
	}
	if got := LogText(NoHealthyError()); got != ErrNoHealthyProxy.Error() {
		t.Fatalf("LogText(no healthy) = %q", got)
	}
	if got := LogText(errors.New("HTTP 500 from test: boom")); got != "HTTP 500 from test: boom" {
		t.Fatalf("LogText(other) = %q", got)
	}
}

func TestStatusOfReason(t *testing.T) {
	for text, want := range map[string]int{
		"Forbidden":                         http.StatusForbidden,
		"forbidden":                         http.StatusForbidden,
		"Bad Gateway":                       http.StatusBadGateway,
		"407 Proxy Authentication Required": http.StatusProxyAuthRequired,
		"OK":                                0,
		"connection refused":                0,
		"999 Nope":                          0,
	} {
		if got := StatusOfReason(text); got != want {
			t.Errorf("StatusOfReason(%q) = %d, want %d", text, got, want)
		}
	}
}

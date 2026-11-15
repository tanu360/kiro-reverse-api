package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
)

func TestForwarderSetsTunnelHeadersAndKeepsHost(t *testing.T) {
	var got *http.Request
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		io.WriteString(w, "ok")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	fwd := newForwarder(targetURL, "s3cret")
	req := httptest.NewRequest(http.MethodGet, "https://kiro-proxy.tail1234.ts.net/admin/", nil)
	// A visitor who sends the tunnel headers must not get them through.
	req.Header.Set(headerSecret, "guess")
	req.Header.Set(headerClient, "10.0.0.1:1")
	req.Header.Set("X-Forwarded-For", "10.0.0.2")
	visitor := netip.MustParseAddrPort("203.0.113.7:51234")
	req = req.WithContext(context.WithValue(req.Context(), clientAddrKey{}, visitor))
	rec := httptest.NewRecorder()
	fwd.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("response = %d %q", rec.Code, rec.Body.String())
	}
	if v := got.Header.Values(headerSecret); len(v) != 1 || v[0] != "s3cret" {
		t.Errorf("%s = %q, want the helper's secret only", headerSecret, v)
	}
	if v := got.Header.Get(headerClient); v != visitor.String() {
		t.Errorf("%s = %q, want %q", headerClient, v, visitor)
	}
	if got.Host != "kiro-proxy.tail1234.ts.net" {
		t.Errorf("Host = %q, want the public host", got.Host)
	}
	if got.Header.Get("X-Forwarded-Proto") != "https" {
		t.Errorf("X-Forwarded-Proto = %q", got.Header.Get("X-Forwarded-Proto"))
	}
}

func TestForwarderWithoutVisitorAddressSendsNoClientHeader(t *testing.T) {
	var got http.Header
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	req := httptest.NewRequest(http.MethodGet, "https://h.ts.net/", nil)
	req.Header.Set(headerClient, "198.51.100.1:9")
	newForwarder(targetURL, "s").ServeHTTP(httptest.NewRecorder(), req)
	if v := got.Get(headerClient); v != "" {
		t.Errorf("%s = %q, want none", headerClient, v)
	}
}

func TestForwarderStreamsEachChunk(t *testing.T) {
	release := make(chan struct{})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, "data: two\n\n")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	front := httptest.NewServer(newForwarder(targetURL, "s"))
	defer front.Close()
	resp, err := http.Get(front.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 64)
	done := make(chan string, 1)
	go func() {
		n, _ := resp.Body.Read(buf)
		done <- string(buf[:n])
	}()
	select {
	case first := <-done:
		if first != "data: one\n\n" {
			t.Errorf("first chunk = %q", first)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the first event did not arrive before the stream ended")
	}
	close(release)
}

func TestForwarderAnswersBadGatewayWhenProxyIsDown(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	targetURL, _ := url.Parse("http://" + addr)
	rec := httptest.NewRecorder()
	newForwarder(targetURL, "s").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "https://h.ts.net/", nil))
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}

func TestClientAddrPrefersFunnelSource(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	src := netip.MustParseAddrPort("203.0.113.9:4444")
	funnel := &ipn.FunnelConn{Conn: a, Src: src}
	got, ok := clientAddr(tls.Server(funnel, &tls.Config{}))
	if !ok || got != src {
		t.Errorf("clientAddr = %v %v, want %v", got, ok, src)
	}
}

func TestClientAddrUsesTailnetPeer(t *testing.T) {
	c := &fakeConn{remote: &net.TCPAddr{IP: net.ParseIP("100.64.0.5"), Port: 3333}}
	got, ok := clientAddr(c)
	if !ok || got.String() != "100.64.0.5:3333" {
		t.Errorf("clientAddr = %v %v", got, ok)
	}
}

type fakeConn struct {
	net.Conn
	remote net.Addr
}

func (c *fakeConn) RemoteAddr() net.Addr { return c.remote }

func TestStatusWriterSkipsRepeats(t *testing.T) {
	var buf bytes.Buffer
	w := newStatusWriter(&buf)
	w.emit(Status{State: stateStarting})
	w.emit(Status{State: stateStarting})
	w.emit(Status{State: stateNeedsLogin, AuthURL: "https://login.tailscale.com/a/1"})
	w.emit(Status{State: stateNeedsLogin, AuthURL: "https://login.tailscale.com/a/1"})
	w.emit(Status{State: stateNeedsLogin, AuthURL: "https://login.tailscale.com/a/2"})

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3:\n%s", len(lines), buf.String())
	}
	var last Status
	if err := json.Unmarshal([]byte(lines[2]), &last); err != nil {
		t.Fatal(err)
	}
	if last.Protocol != protocolVersion || last.AuthURL != "https://login.tailscale.com/a/2" {
		t.Errorf("last = %+v", last)
	}
}

func TestLoginStatus(t *testing.T) {
	cases := []struct {
		st   ipnstate.Status
		want Status
		ok   bool
	}{
		{ipnstate.Status{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x"}, Status{State: stateNeedsLogin, AuthURL: "https://login.tailscale.com/a/x"}, true},
		{ipnstate.Status{BackendState: "NeedsLogin"}, Status{State: stateStarting}, true},
		{ipnstate.Status{BackendState: "NeedsMachineAuth"}, Status{State: stateNeedsApproval, AdminURL: adminMachinesURL}, true},
		{ipnstate.Status{BackendState: "Starting"}, Status{State: stateStarting}, true},
		{ipnstate.Status{BackendState: "Running"}, Status{}, false},
	}
	for _, c := range cases {
		got, ok := loginStatus(&c.st)
		if got != c.want || ok != c.ok {
			t.Errorf("loginStatus(%s) = %+v %v, want %+v %v", c.st.BackendState, got, ok, c.want, c.ok)
		}
	}
}

func TestRunningStatusCarriesKeyExpiryAndTheMachinePage(t *testing.T) {
	expiry := time.Date(2027, 5, 14, 10, 30, 0, 0, time.FixedZone("IST", 19800))
	st := &ipnstate.Status{Self: &ipnstate.PeerStatus{
		KeyExpiry:    &expiry,
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("fd7a:115c:a1e0::1"), netip.MustParseAddr("100.101.102.103")},
	}}
	got := runningStatus("https://kiro-proxy.tail1234.ts.net", st)
	want := Status{
		State:      stateRunning,
		URL:        "https://kiro-proxy.tail1234.ts.net",
		KeyExpiry:  "2027-05-14T05:00:00Z",
		MachineURL: "https://login.tailscale.com/admin/machines/100.101.102.103",
	}
	if got != want {
		t.Errorf("runningStatus = %+v, want %+v", got, want)
	}

	// Key expiry turned off: no date.
	st.Self.KeyExpiry = nil
	if got := runningStatus("https://kiro-proxy.tail1234.ts.net", st); got.KeyExpiry != "" || got.MachineURL == "" {
		t.Errorf("expiry off: %+v", got)
	}
	if got := runningStatus("https://x.ts.net", &ipnstate.Status{}); got != (Status{State: stateRunning, URL: "https://x.ts.net"}) {
		t.Errorf("no Self: %+v", got)
	}
}

func TestWatchParentCancelsOnEOFAndAsksForLogout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	logout := make(chan struct{}, 1)
	watchParent(strings.NewReader(""), cancel, logout)
	if ctx.Err() == nil {
		t.Error("EOF on stdin did not cancel")
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	watchParent(strings.NewReader("noise\nlogout\n"), cancel2, logout)
	select {
	case <-logout:
	default:
		t.Error("logout was not requested")
	}
	if ctx2.Err() != nil {
		t.Error("logout must not cancel before the sign-out runs")
	}
}

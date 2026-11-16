package main

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestProbeHandlerAnswersOnlyItsToken(t *testing.T) {
	forwarded := 0
	h := probeHandler("t0ken", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		forwarded++
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "https://kiro-proxy.tail1234.ts.net/", nil)
	req.Header.Set(headerProbe, "t0ken")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get(headerProbe) != "t0ken" || forwarded != 0 {
		t.Fatalf("own token: code %d, header %q, forwarded %d", rec.Code, rec.Header().Get(headerProbe), forwarded)
	}

	for _, token := range []string{"", "guess"} {
		req := httptest.NewRequest(http.MethodGet, "https://kiro-proxy.tail1234.ts.net/", nil)
		if token != "" {
			req.Header.Set(headerProbe, token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Header().Get(headerProbe) != "" {
			t.Errorf("token %q: code %d, header %q; want it passed to the proxy", token, rec.Code, rec.Header().Get(headerProbe))
		}
	}
	if forwarded != 2 {
		t.Errorf("forwarded %d requests, want 2", forwarded)
	}
}

// relays maps each fake public address to a test listener; an address without one cannot be
// reached.
type relays map[netip.Addr]string

func testProber(t *testing.T, token string, addrs []netip.Addr, lookupErr error, to relays) *prober {
	t.Helper()
	srv := httptest.NewTLSServer(probeHandler(token, http.NotFoundHandler()))
	t.Cleanup(srv.Close)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	for addr, target := range to {
		if target == "helper" {
			to[addr] = srv.Listener.Addr().String()
		}
	}
	return &prober{
		token: token,
		resolve: func(context.Context, string) ([]netip.Addr, error) {
			return addrs, lookupErr
		},
		dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			ap := netip.MustParseAddrPort(address)
			target, ok := to[ap.Addr()]
			if !ok {
				return nil, errors.New("network is unreachable")
			}
			var d net.Dialer
			return d.DialContext(ctx, network, target)
		},
		port:  443,
		roots: roots,
	}
}

// closingRelay accepts connections and closes them, as a Funnel relay does for a device it has
// not heard of yet.
func closingRelay(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	return ln.Addr().String()
}

var (
	relayA = netip.MustParseAddr("192.0.2.1")
	relayB = netip.MustParseAddr("192.0.2.2")
	relay6 = netip.MustParseAddr("2001:db8::1")
)

// httptest's certificate is for example.com.
const probeHost = "example.com"

func TestProberIsLiveWhenEveryReachableAddressAnswers(t *testing.T) {
	p := testProber(t, "t0ken", []netip.Addr{relayA, relayB, relay6}, nil,
		relays{relayA: "helper", relayB: "helper"}) // no IPv6 route
	if !p.live(context.Background(), probeHost) {
		t.Fatal("live = false, want true")
	}
}

func TestProberWaitsForARelayThatClosesTheConnection(t *testing.T) {
	p := testProber(t, "t0ken", []netip.Addr{relayA, relayB}, nil,
		relays{relayA: "helper", relayB: closingRelay(t)})
	if p.live(context.Background(), probeHost) {
		t.Fatal("live = true while one relay drops visitors")
	}
}

func TestProberIgnoresAServerWithoutTheToken(t *testing.T) {
	// Another helper (an older one with the same name, say) answers with its own token.
	p := testProber(t, "t0ken", []netip.Addr{relayA}, nil, relays{relayA: "helper"})
	p.token = "other"
	if p.live(context.Background(), probeHost) {
		t.Fatal("live = true for a server that does not know the token")
	}
}

func TestProberIsNotLiveWithoutAnAddress(t *testing.T) {
	notFound := &net.DNSError{Err: "no such host", Name: probeHost, IsNotFound: true}
	cases := map[string]*prober{
		"not published": testProber(t, "t0ken", nil, notFound, relays{}),
		"unreachable":   testProber(t, "t0ken", []netip.Addr{relay6}, nil, relays{}),
	}
	for name, p := range cases {
		if p.live(context.Background(), probeHost) {
			t.Errorf("%s: live = true", name)
		}
	}
}

func TestWaitPublishedShowsTheLinkAfterPublishWait(t *testing.T) {
	defer func(poll, wait time.Duration) { publishPoll, publishWait = poll, wait }(publishPoll, publishWait)
	publishPoll, publishWait = 10*time.Millisecond, 50*time.Millisecond

	p := testProber(t, "t0ken", []netip.Addr{relayA}, nil, relays{relayA: closingRelay(t)})
	start := time.Now()
	if !p.waitPublished(context.Background(), probeHost) {
		t.Fatal("waitPublished = false, want true once publishWait passed")
	}
	if elapsed := time.Since(start); elapsed < publishWait {
		t.Errorf("returned after %v, before publishWait", elapsed)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p.waitPublished(ctx, probeHost) {
		t.Error("waitPublished = true after its context ended")
	}
}

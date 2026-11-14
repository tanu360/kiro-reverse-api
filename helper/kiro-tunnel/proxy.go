package main

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"time"

	"tailscale.com/ipn"
)

type clientAddrKey struct{}

// connContext remembers who is on the other end of a connection. A Funnel connection's
// RemoteAddr is the Tailscale relay; its Src is the visitor. A tailnet connection's RemoteAddr is
// already the peer.
func connContext(ctx context.Context, c net.Conn) context.Context {
	if addr, ok := clientAddr(c); ok {
		return context.WithValue(ctx, clientAddrKey{}, addr)
	}
	return ctx
}

func clientAddr(c net.Conn) (netip.AddrPort, bool) {
	if tc, ok := c.(*tls.Conn); ok {
		c = tc.NetConn()
	}
	if fc, ok := c.(*ipn.FunnelConn); ok && fc.Src.IsValid() {
		return fc.Src, true
	}
	if addr, err := netip.ParseAddrPort(c.RemoteAddr().String()); err == nil {
		return addr, true
	}
	return netip.AddrPort{}, false
}

// newForwarder returns the handler that passes every request to the proxy. It streams responses
// as they come (SSE), keeps the visitor's Host so links the proxy builds point at the public URL,
// and replaces any tunnel headers a visitor sent with its own.
func newForwarder(target *url.URL, secret string) http.Handler {
	transport := &http.Transport{
		Proxy:               nil, // the target is loopback
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
		// Pass the body through as the proxy sent it; the visitor's client decodes it.
		DisableCompression: true,
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			pr.Out.Header.Del(headerSecret)
			pr.Out.Header.Del(headerClient)
			pr.Out.Header.Set(headerSecret, secret)
			if addr, ok := pr.In.Context().Value(clientAddrKey{}).(netip.AddrPort); ok {
				pr.Out.Header.Set(headerClient, addr.String())
			}
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
			pr.Out.Header.Set("X-Forwarded-Host", pr.In.Host)
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Kiro Proxy is not answering on this machine.", http.StatusBadGateway)
		},
	}
}

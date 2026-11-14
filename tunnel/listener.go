package tunnel

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"time"
)

// The contract with the helper (helper/kiro-tunnel/status.go).
const (
	secretEnv    = "KIRO_TUNNEL_SECRET"
	headerSecret = "X-Kiro-Tunnel-Secret"
	headerClient = "X-Kiro-Tunnel-Client"
)

// unknownVisitor stands in for a visitor whose address the helper could not tell. All such
// requests share one sign-in lockout, which is safer than sharing the loopback address.
const unknownVisitor = "0.0.0.0:0"

type fromTunnelKey struct{}

// FromTunnel reports whether r came in through the public link. Such a request is from the
// internet, whatever its RemoteAddr says.
func FromTunnel(r *http.Request) bool {
	v, _ := r.Context().Value(fromTunnelKey{}).(bool)
	return v
}

// WithTunnel marks ctx as a public-link request; for tests in other packages.
func WithTunnel(ctx context.Context) context.Context {
	return context.WithValue(ctx, fromTunnelKey{}, true)
}

// middleware admits only the helper's requests, sets RemoteAddr to the visitor's address so the
// sign-in lockout and the logs see the real caller, and marks the request as public.
func middleware(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(headerSecret)), []byte(secret)) != 1 {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		r.Header.Del(headerSecret)
		client := r.Header.Get(headerClient)
		r.Header.Del(headerClient)
		r.RemoteAddr = unknownVisitor
		if addr, err := netip.ParseAddrPort(client); err == nil {
			r.RemoteAddr = addr.String()
		}
		next.ServeHTTP(w, r.WithContext(WithTunnel(r.Context())))
	})
}

// listen opens the loopback listener the helper forwards to. It is separate from the proxy's
// own listener, so the proxy's LISTEN_HOST and port need not change for the public link.
func listen(secret string, handler http.Handler) (net.Listener, *http.Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	server := &http.Server{
		Handler:           middleware(secret, handler),
		ReadHeaderTimeout: 30 * time.Second,
	}
	go func() { _ = server.Serve(ln) }()
	return ln, server, nil
}

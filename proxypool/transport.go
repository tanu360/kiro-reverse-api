package proxypool

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
)

// Kinds of proxy failure. Only failures before a connection to the upstream
// exists count; an upstream HTTP status never does.
const (
	KindDNS       = "dns"
	KindConnect   = "connect"
	KindTimeout   = "timeout"
	KindTLS       = "tls"
	KindAuth      = "auth"
	KindTunnel    = "tunnel"
	KindSOCKS     = "socks"
	KindNoHealthy = "no_healthy"
)

// ErrNoHealthyProxy is the cause of a request the pool had no proxy for.
var ErrNoHealthyProxy = errors.New("no healthy outbound proxy in the pool")

// ProxyError is a request that failed at its pool proxy. Its text is fixed
// wording: the account failover reads error text, and a cause such as a SOCKS
// "authentication failed" or a CONNECT "Forbidden" would read as a banned
// account. The cause stays reachable through Unwrap.
type ProxyError struct {
	ProxyID string
	Kind    string
	cause   error
}

func (e *ProxyError) Error() string {
	if e.Kind == KindNoHealthy {
		return ErrNoHealthyProxy.Error()
	}
	return "outbound pool proxy failed: " + kindText(e.Kind)
}

func (e *ProxyError) Unwrap() error { return e.cause }

func kindText(kind string) string {
	switch kind {
	case KindDNS:
		return "proxy host lookup failed"
	case KindTimeout:
		return "connection timed out"
	case KindTLS:
		return "TLS handshake failed"
	case KindAuth:
		return "proxy rejected the sign-in"
	case KindTunnel:
		return "proxy refused the tunnel"
	case KindSOCKS:
		return "SOCKS handshake failed"
	case KindNoHealthy:
		return "no healthy proxy"
	default:
		return "connection refused or reset"
	}
}

// IsProxyError reports whether err failed at a pool proxy (or found none).
func IsProxyError(err error) bool {
	var perr *ProxyError
	return errors.As(err, &perr)
}

// IsNoHealthy reports whether err is a request the pool had no proxy for.
func IsNoHealthy(err error) bool {
	var perr *ProxyError
	return errors.As(err, &perr) && perr.Kind == KindNoHealthy
}

// NoHealthyError is the error a request gets when the pool has no proxy for it.
func NoHealthyError() error {
	return &ProxyError{Kind: KindNoHealthy, cause: ErrNoHealthyProxy}
}

func newProxyError(id string, err error) *ProxyError {
	return &ProxyError{ProxyID: id, Kind: classify(err), cause: err}
}

// classify names a transport error that happened before a connection existed.
func classify(err error) string {
	msg := strings.ToLower(err.Error())
	var dnsErr *net.DNSError
	var netErr net.Error
	var recordErr tls.RecordHeaderError
	var verifyErr *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameErr x509.HostnameError
	switch {
	case strings.Contains(msg, "proxy authentication required"),
		strings.Contains(msg, "username/password authentication failed"),
		strings.Contains(msg, "no acceptable authentication methods"):
		return KindAuth
	case errors.As(err, &dnsErr):
		return KindDNS
	case errors.As(err, &netErr) && netErr.Timeout():
		return KindTimeout
	case errors.As(err, &recordErr), errors.As(err, &verifyErr), errors.As(err, &unknownAuthority),
		errors.As(err, &hostnameErr), strings.Contains(msg, "tls:"), strings.Contains(msg, "x509:"):
		return KindTLS
	case strings.Contains(msg, "socks"):
		return KindSOCKS
	case isConnectStatus(err.Error()):
		return KindTunnel
	default:
		return KindConnect
	}
}

// isConnectStatus matches the bare reason phrase Go returns for a CONNECT the
// proxy answered with anything but 200.
func isConnectStatus(msg string) bool {
	for code := 400; code < 600; code++ {
		if text := http.StatusText(code); text != "" && strings.EqualFold(msg, text) {
			return true
		}
	}
	return false
}

// Instrument wraps a transport that dials through pool proxy id: a failure
// before the connection exists marks the proxy failed and moves its accounts;
// a new connection marks it healthy. A canceled request is never held against it.
func Instrument(id string, base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &instrumentedTransport{id: id, base: base}
}

type instrumentedTransport struct {
	id   string
	base http.RoundTripper
}

func (t *instrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var connected, fresh atomic.Bool
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			connected.Store(true)
			if !info.Reused {
				fresh.Store(true)
			}
		},
	}
	resp, err := t.base.RoundTrip(req.WithContext(httptrace.WithClientTrace(req.Context(), trace)))
	if err != nil {
		if connected.Load() || req.Context().Err() != nil {
			return nil, err
		}
		perr := newProxyError(t.id, err)
		Default().ReportFailure(t.id, perr)
		return nil, perr
	}
	//! A plain-HTTP request through an HTTP proxy gets the 407 as a response, not a CONNECT error.
	if resp.StatusCode == http.StatusProxyAuthRequired {
		resp.Body.Close()
		perr := &ProxyError{ProxyID: t.id, Kind: KindAuth, cause: errors.New(resp.Status)}
		Default().ReportFailure(t.id, perr)
		return nil, perr
	}
	if fresh.Load() {
		Default().ReportSuccess(t.id)
	}
	return resp, nil
}

// CloseIdleConnections lets http.Client.CloseIdleConnections reach the wrapped transport.
func (t *instrumentedTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// WrapClient returns a copy of c whose transport reports to pool proxy id. The
// copy shares c's transport, so its connections are reused.
func WrapClient(id string, c *http.Client) *http.Client {
	wrapped := *c
	wrapped.Transport = Instrument(id, c.Transport)
	return &wrapped
}

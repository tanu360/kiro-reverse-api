package proxypool

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
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

// DescribeProxyFailure names a request that failed at an outbound proxy outside
// the pool (an account's own or the global proxy) in ProxyError's fixed
// wording: an HTTP proxy's dial, TLS or CONNECT, or a SOCKS handshake. Go's
// error repeats the request URL and the proxy's host:port, which a client must
// not see. ok is false for any other error, a direct dial included.
func DescribeProxyFailure(err error) (text string, ok bool) {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		err = urlErr.Err
	}
	var opErr *net.OpError
	atProxy := errors.As(err, &opErr) && (opErr.Op == "proxyconnect" || strings.HasPrefix(opErr.Op, "socks"))
	if !atProxy && !isConnectStatus(err.Error()) {
		return "", false
	}
	return kindText(classify(err)), true
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

// connectTimeout bounds a request's way to its connection: the dial, the proxy
// handshake and TLS. Go runs a SOCKS handshake with no deadline of its own and
// gives a CONNECT a full minute, so without it a proxy that accepts and then
// stalls holds every request until the caller gives up, and a caller that gives
// up is never held against the proxy.
var connectTimeout = 15 * time.Second

// connectTimeoutError is the cause of a request that got no connection within connectTimeout.
type connectTimeoutError struct{ budget time.Duration }

func (e *connectTimeoutError) Error() string {
	return fmt.Sprintf("no connection through the proxy within %s", e.budget)
}

func (e *connectTimeoutError) Timeout() bool   { return true }
func (e *connectTimeoutError) Temporary() bool { return true }

// States of a request's connection, for the race between GotConn and the connect timer.
const (
	connPending int32 = iota
	connReady
	connExpired
)

// Instrument wraps a transport that dials through pool proxy id at dialURL: a
// failure before the connection exists, or no connection within connectTimeout,
// marks the proxy failed and moves its accounts; a new connection marks it
// healthy. A canceled request is never held against it, and neither is any
// report once the proxy has been edited to another address or sign-in.
func Instrument(id, dialURL string, base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &instrumentedTransport{id: id, url: dialURL, base: base}
}

type instrumentedTransport struct {
	id   string
	url  string
	base http.RoundTripper
}

func (t *instrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	parent := req.Context()
	ctx, cancel := context.WithCancelCause(parent)
	var state atomic.Int32
	var fresh atomic.Bool
	budget := connectTimeout
	timer := time.AfterFunc(budget, func() {
		if state.CompareAndSwap(connPending, connExpired) {
			cancel(&connectTimeoutError{budget: budget})
		}
	})
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			if state.CompareAndSwap(connPending, connReady) {
				timer.Stop()
			}
			if !info.Reused {
				fresh.Store(true)
			}
		},
	}
	resp, err := t.base.RoundTrip(req.WithContext(httptrace.WithClientTrace(ctx, trace)))
	timer.Stop()
	if err != nil {
		cause := context.Cause(ctx)
		cancel(nil)
		var expired *connectTimeoutError
		timedOut := errors.As(cause, &expired)
		if state.Load() == connReady || (!timedOut && parent.Err() != nil) {
			return nil, err
		}
		var perr *ProxyError
		if timedOut {
			perr = &ProxyError{ProxyID: t.id, Kind: KindTimeout, cause: cause}
			//! Go keeps dialing after the request gave up (the dial outlives the request);
			//! this cancels that dial, which a stalled SOCKS handshake would otherwise hold forever.
			t.CloseIdleConnections()
		} else {
			perr = newProxyError(t.id, err)
		}
		Default().reportFailure(t.id, t.url, perr)
		return nil, perr
	}
	//! A plain-HTTP request through an HTTP proxy gets the 407 as a response, not a CONNECT error.
	if resp.StatusCode == http.StatusProxyAuthRequired {
		resp.Body.Close()
		cancel(nil)
		perr := &ProxyError{ProxyID: t.id, Kind: KindAuth, cause: errors.New(resp.Status)}
		Default().reportFailure(t.id, t.url, perr)
		return nil, perr
	}
	if fresh.Load() {
		Default().reportSuccess(t.id, t.url)
	}
	//! The body reads on ctx: it is released when the body is closed, not here.
	if resp.Body == nil {
		cancel(nil)
	} else {
		resp.Body = &releaseBody{ReadCloser: resp.Body, release: func() { cancel(nil) }}
	}
	return resp, nil
}

// releaseBody runs release once the response body is closed.
type releaseBody struct {
	io.ReadCloser
	release func()
}

func (b *releaseBody) Close() error {
	err := b.ReadCloser.Close()
	b.release()
	return err
}

// CloseIdleConnections lets http.Client.CloseIdleConnections reach the wrapped transport.
func (t *instrumentedTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// WrapClient returns a copy of c whose transport reports to pool proxy id, dialed
// at dialURL. The copy shares c's transport, so its connections are reused.
func WrapClient(id, dialURL string, c *http.Client) *http.Client {
	wrapped := *c
	wrapped.Transport = Instrument(id, dialURL, c.Transport)
	return &wrapped
}

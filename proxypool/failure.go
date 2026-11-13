package proxypool

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"kiro-proxy/config"
)

// Failure names a request that failed at an outbound proxy before it reached the
// upstream, in terms the admin UI translates. Kind is one of the Kind constants.
// Status is the proxy's HTTP answer to the CONNECT (a KindTunnel refusal or a 407
// KindAuth); 0 when there was none or the answer carried no known status.
type Failure struct {
	Kind   string
	Status int
}

// Text is the failure in fixed English wording, as clients and logs read it.
func (f Failure) Text() string { return kindText(f.Kind) }

// Describe names err when it failed at an outbound proxy: a pool proxy (a
// ProxyError, no healthy proxy included) or an account's own or the global proxy
// (see DescribeProxyFailure). ok is false for any other error.
func Describe(err error) (Failure, bool) {
	var perr *ProxyError
	if errors.As(err, &perr) {
		return Failure{Kind: perr.Kind, Status: connectAnswer(perr.Kind, perr.cause)}, true
	}
	return describeOutbound(err)
}

// describeOutbound is Describe for a proxy outside the pool: an HTTP proxy's dial,
// TLS or CONNECT, a SOCKS handshake, or no connection within connectTimeout.
func describeOutbound(err error) (Failure, bool) {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		err = urlErr.Err
	}
	var expired *connectTimeoutError
	if errors.As(err, &expired) {
		return Failure{Kind: KindTimeout}, true
	}
	var outbound *outboundProxyError
	if errors.As(err, &outbound) {
		kind := classify(outbound.cause)
		return Failure{Kind: kind, Status: connectAnswer(kind, outbound.cause)}, true
	}
	var opErr *net.OpError
	var refused *connectRefusedError
	atProxy := errors.As(err, &opErr) && (opErr.Op == "proxyconnect" || strings.HasPrefix(opErr.Op, "socks"))
	if !atProxy && !errors.As(err, &refused) && !isConnectStatus(err.Error()) {
		return Failure{}, false
	}
	kind := classify(err)
	return Failure{Kind: kind, Status: connectAnswer(kind, err)}, true
}

// connectAnswer is the HTTP status a proxy answered a CONNECT with: kept by
// KeepConnectAnswer, or else read from the cause's text, where Go keeps only the
// reason phrase ("Forbidden") and a 407 the transport saw as a response reads
// "407 Proxy Authentication Required".
func connectAnswer(kind string, cause error) int {
	var refused *connectRefusedError
	if errors.As(cause, &refused) {
		return refused.status
	}
	if cause == nil || (kind != KindTunnel && kind != KindAuth && kind != KindAuthRequired) {
		return 0
	}
	return StatusOfReason(cause.Error())
}

// connectRefusedError is a CONNECT the proxy answered with a status other than 200.
// It reads as Go's own error for that answer, the bare reason phrase, so every check
// on the text works as before. The status and whether the CONNECT carried a sign-in
// stay readable when the phrase is not a standard one ("403 Access violation").
type connectRefusedError struct {
	status int
	reason string
	signIn bool
}

func (e *connectRefusedError) Error() string {
	if e.reason == "" {
		return "unknown status code"
	}
	return e.reason
}

func (e *connectRefusedError) kind() string { return answerKind(e.status, e.signIn) }

// answerKind is the failure a proxy's refusal names: a 407 asks for a sign-in that
// was not sent, or rejects the one that was; any other status refuses the tunnel.
func answerKind(status int, signIn bool) string {
	switch {
	case status != http.StatusProxyAuthRequired:
		return KindTunnel
	case signIn:
		return KindAuth
	default:
		return KindAuthRequired
	}
}

// hasSignIn reports whether a proxy URL carries a username.
func hasSignIn(rawURL string) bool {
	u, err := url.Parse(rawURL)
	return err == nil && u.User != nil
}

// KeepConnectAnswer makes t fail a CONNECT its proxy refused with the proxy's status
// and whether the CONNECT carried a sign-in, not only the reason phrase Go keeps.
func KeepConnectAnswer(t *http.Transport) {
	t.OnProxyConnectResponse = onConnectAnswer
}

func onConnectAnswer(_ context.Context, proxyURL *url.URL, _ *http.Request, res *http.Response) error {
	//! The same test as Go's own, which runs right after this one.
	if res.StatusCode == http.StatusOK {
		return nil
	}
	_, reason, _ := strings.Cut(res.Status, " ")
	return &connectRefusedError{status: res.StatusCode, reason: reason, signIn: proxyURL != nil && proxyURL.User != nil}
}

// LogText is err for the server log. A pool proxy failure reads as its fixed
// wording, so its cause is added, with the proxy's secrets removed; any other
// error reads as it is.
func LogText(err error) string {
	var perr *ProxyError
	if !errors.As(err, &perr) || perr.cause == nil || perr.cause == ErrNoHealthyProxy {
		return err.Error()
	}
	p, _ := findProxy(config.GetProxyPool(), perr.ProxyID)
	return err.Error() + " (" + Redact(perr.cause.Error(), p) + ")"
}

// StatusOfReason is the HTTP status a proxy's CONNECT answer names: a leading code
// ("407 Proxy Authentication Required") or a bare standard reason phrase
// ("Forbidden"). 0 when it names none.
func StatusOfReason(text string) int {
	text = strings.TrimSpace(text)
	if code, rest, ok := strings.Cut(text, " "); ok && len(code) == 3 {
		if n, err := strconv.Atoi(code); err == nil && n >= 100 && n <= 599 && rest != "" {
			return n
		}
	}
	for code := 400; code < 600; code++ {
		if phrase := http.StatusText(code); phrase != "" && strings.EqualFold(text, phrase) {
			return code
		}
	}
	return 0
}

// FailureOfText reads a failure from its fixed wording, in any case, alone or
// followed by ": " and the cause, as a pool proxy's last error saved before Health
// had ErrorCode.
func FailureOfText(text string) (Failure, bool) {
	for _, kind := range []string{KindDNS, KindTimeout, KindTLS, KindAuth, KindAuthRequired, KindTunnel, KindSOCKS, KindConnect, KindNoHealthy} {
		head := kindText(kind)
		if len(text) < len(head) || !strings.EqualFold(text[:len(head)], head) {
			continue
		}
		rest := text[len(head):]
		if rest == "" {
			return Failure{Kind: kind}, true
		}
		if cause, ok := strings.CutPrefix(rest, ": "); ok {
			if kind == KindTunnel || kind == KindAuth || kind == KindAuthRequired {
				return Failure{Kind: kind, Status: StatusOfReason(cause)}, true
			}
			return Failure{Kind: kind}, true
		}
	}
	return Failure{}, false
}

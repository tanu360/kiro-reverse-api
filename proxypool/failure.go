package proxypool

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
	atProxy := errors.As(err, &opErr) && (opErr.Op == "proxyconnect" || strings.HasPrefix(opErr.Op, "socks"))
	if !atProxy && !isConnectStatus(err.Error()) {
		return Failure{}, false
	}
	kind := classify(err)
	return Failure{Kind: kind, Status: connectAnswer(kind, err)}, true
}

// connectAnswer is the HTTP status a proxy answered a CONNECT with, read from the
// cause's text: Go keeps only the reason phrase ("Forbidden"), and a 407 the
// transport saw as a response reads "407 Proxy Authentication Required".
func connectAnswer(kind string, cause error) int {
	if cause == nil || (kind != KindTunnel && kind != KindAuth) {
		return 0
	}
	return StatusOfReason(cause.Error())
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
	for _, kind := range []string{KindDNS, KindTimeout, KindTLS, KindAuth, KindTunnel, KindSOCKS, KindConnect, KindNoHealthy} {
		head := kindText(kind)
		if len(text) < len(head) || !strings.EqualFold(text[:len(head)], head) {
			continue
		}
		rest := text[len(head):]
		if rest == "" {
			return Failure{Kind: kind}, true
		}
		if cause, ok := strings.CutPrefix(rest, ": "); ok {
			if kind == KindTunnel || kind == KindAuth {
				return Failure{Kind: kind, Status: StatusOfReason(cause)}, true
			}
			return Failure{Kind: kind}, true
		}
	}
	return Failure{}, false
}

package proxy

import (
	"net/http"
	"regexp"
	"strings"

	"kiro-proxy/config"
	"kiro-proxy/proxypool"
)

// errorTypeProxy is the request log error type of a request or a try that failed
// at an outbound proxy before it reached Kiro: the account's own proxy, the global
// proxy or a pool proxy, or no healthy proxy in the pool.
const errorTypeProxy = "proxy"

// Where the proxy that failed came from.
const (
	proxySourceAccount = "account"
	proxySourceGlobal  = "global"
	proxySourcePool    = "pool"
)

// attemptProxyFailure is how a try failed at its outbound proxy, for the admin UI's
// own wording. Code is a proxypool Kind ("connect", "timeout", "auth", "tunnel",
// ...). Status is the proxy's answer to CONNECT when it refused one. Source is ""
// on a row logged before the failure was recorded this way.
type attemptProxyFailure struct {
	Source string `json:"source,omitempty"`
	Code   string `json:"code"`
	Status int    `json:"status,omitempty"`
}

// proxyFailureOf names a try's error that failed at an outbound proxy, and where
// that proxy came from: the pool, the account's own proxy, or else the global one.
func proxyFailureOf(account *config.Account, err error) (*attemptProxyFailure, bool) {
	failure, ok := proxypool.Describe(err)
	if !ok {
		return nil, false
	}
	source := proxySourceGlobal
	switch {
	case proxypool.IsProxyError(err):
		source = proxySourcePool
	case account != nil && account.ProxyURL != "":
		source = proxySourceAccount
	}
	return &attemptProxyFailure{Source: source, Code: failure.Kind, Status: failure.Status}, true
}

// isProxyFailureMessage matches the text of a proxy failure that reaches the
// request log as a string only: the fixed wording clients get, or Go's text for a
// failed proxy dial, CONNECT or SOCKS handshake.
func isProxyFailureMessage(message string) bool {
	_, _, ok := loggedProxyFailure(message)
	return ok
}

// goRequestError is the shape of Go's error for a request that failed before any
// answer: the method as Go writes it ("Post"), the quoted URL, then the cause.
var goRequestError = regexp.MustCompile(`^[A-Z][A-Za-z]* "[^"]*": (.+)$`)

// loggedProxyFailure reads a proxy failure from a message logged before attempts
// carried one: Go's raw text, which repeats Kiro's URL and the proxy's address, or
// the fixed wording. It returns text without Go's wording (a message already in
// the fixed wording comes back as it is) and what failed.
func loggedProxyFailure(message string) (string, *attemptProxyFailure, bool) {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "no healthy outbound proxy"):
		return message, &attemptProxyFailure{Source: proxySourcePool, Code: proxypool.KindNoHealthy}, true
	case strings.Contains(lower, "outbound pool proxy failed: "):
		_, text, _ := strings.Cut(lower, "outbound pool proxy failed: ")
		return message, &attemptProxyFailure{Source: proxySourcePool, Code: kindOfText(text)}, true
	case strings.Contains(lower, "outbound proxy failed: "):
		_, text, _ := strings.Cut(lower, "outbound proxy failed: ")
		return message, &attemptProxyFailure{Code: kindOfText(text)}, true
	//! "proxy connect timeout" is the wording of dev builds before the fixed one.
	case strings.Contains(lower, "no connection through the proxy within"), strings.Contains(lower, "proxy connect timeout"):
		return outboundProxyWording(&attemptProxyFailure{Code: proxypool.KindTimeout})
	case strings.Contains(lower, "socks connect "):
		code := proxypool.KindSOCKS
		switch {
		case strings.Contains(lower, "no acceptable authentication"):
			code = proxypool.KindAuthRequired
		case strings.Contains(lower, "authentication failed"):
			code = proxypool.KindAuth
		case strings.Contains(lower, "no such host"):
			code = proxypool.KindDNS
		case strings.Contains(lower, "connection refused"), strings.Contains(lower, "connection reset"):
			code = proxypool.KindConnect
		case strings.Contains(lower, "timeout"):
			code = proxypool.KindTimeout
		}
		return outboundProxyWording(&attemptProxyFailure{Code: code})
	case strings.Contains(lower, "proxyconnect "):
		code := proxypool.KindConnect
		switch {
		case strings.Contains(lower, "no such host"), strings.Contains(lower, "lookup "):
			code = proxypool.KindDNS
		case strings.Contains(lower, "timeout"):
			code = proxypool.KindTimeout
		case strings.Contains(lower, "tls:"), strings.Contains(lower, "x509:"):
			code = proxypool.KindTLS
		}
		return outboundProxyWording(&attemptProxyFailure{Code: code})
	}
	//! A CONNECT the proxy refused leaves Go's bare reason phrase after the URL ("Forbidden").
	if m := goRequestError.FindStringSubmatch(message); m != nil {
		if status := proxypool.StatusOfReason(m[1]); status != 0 {
			code := proxypool.KindTunnel
			if status == http.StatusProxyAuthRequired {
				code = proxypool.KindAuth
			}
			return outboundProxyWording(&attemptProxyFailure{Code: code, Status: status})
		}
	}
	return "", nil, false
}

func outboundProxyWording(failure *attemptProxyFailure) (string, *attemptProxyFailure, bool) {
	return "outbound proxy failed: " + proxypool.Failure{Kind: failure.Code}.Text(), failure, true
}

// kindOfText is the proxypool Kind whose fixed wording starts text.
func kindOfText(text string) string {
	if failure, ok := proxypool.FailureOfText(text); ok {
		return failure.Kind
	}
	return proxypool.KindConnect
}

// tidyLoggedProxyFailures gives a row read back from the log the fixed wording for
// a proxy failure logged before attempts carried one, in its message and in its
// failed attempts, so no Kiro URL or proxy address shows. Each also reads as the
// "proxy" error a new row gets ("upstream", "auth" or "timeout" before); the
// database keeps what was logged.
func tidyLoggedProxyFailures(rec *requestRecord) {
	if !rec.Success {
		if clean, _, ok := loggedProxyFailure(rec.Message); ok {
			if classifyRequestError(false, rec.Status, rec.Message) == errorTypeProxy {
				rec.ErrorType = errorTypeProxy
			}
			rec.Message = clean
		}
	}
	for i := range rec.Attempts {
		a := &rec.Attempts[i]
		if a.Success || a.Proxy != nil {
			continue
		}
		if clean, failure, ok := loggedProxyFailure(a.Message); ok {
			if classifyRequestError(false, a.Status, a.Message) == errorTypeProxy {
				a.ErrorType = errorTypeProxy
			}
			a.Message = clean
			a.Proxy = failure
		}
	}
}

// proxyFailureRecord is a final request record's error type and message when it
// failed at an outbound proxy: the wording of the try it ended on, or else the
// fixed wording for Go's text, so the row shows no Kiro URL or proxy address.
// Any other record keeps both.
func proxyFailureRecord(trace *requestTrace, success bool, errorType, message string) (string, string) {
	if success {
		return errorType, message
	}
	if clean, ok := trace.proxyFailureMessage(message); ok {
		return errorTypeProxy, clean
	}
	if errorType == errorTypeProxy {
		if clean, _, ok := loggedProxyFailure(message); ok {
			return errorType, clean
		}
	}
	return errorType, message
}

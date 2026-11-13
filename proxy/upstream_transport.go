package proxy

import (
	"context"
	"errors"
	"net"
	"net/url"

	"kiro-proxy/proxypool"
)

// isUpstreamTransportError reports a try that got no complete HTTP answer from
// Kiro: the account's own or the global proxy failed, a DNS lookup or a dial
// failed, the connection was reset, or no answer came in time. A pool proxy
// failure is a proxypool.ProxyError and a client disconnect is context.Canceled;
// neither counts. Nothing in such an error says anything about the account.
func isUpstreamTransportError(err error) bool {
	if err == nil || proxypool.IsProxyError(err) || errors.Is(err, context.Canceled) {
		return false
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// upstreamTransportText is the client text for a transport error. Go's text
// repeats the upstream URL and the proxy's or Kiro's address, so the client
// gets fixed wording; the server log and the request log keep the cause.
func upstreamTransportText(err error) string {
	if text, ok := proxypool.DescribeProxyFailure(err); ok {
		return "outbound proxy failed: " + text
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "upstream request timed out"
	}
	return "upstream connection failed"
}

// neverReachedKiro reports a failure before any connection to Kiro existed: a
// pool proxy failure or none healthy, an own or global proxy that failed its
// dial, CONNECT or SOCKS handshake, or a direct dial that failed.
func neverReachedKiro(err error) bool {
	if proxypool.IsProxyError(err) {
		return true
	}
	if _, atProxy := proxypool.DescribeProxyFailure(err); atProxy {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

// outboundProxyFailure names a try that failed at the account's own or the global proxy: its
// dial, CONNECT, SOCKS handshake or connect deadline. Every endpoint and every retry of the
// account dial that proxy again, so the request moves on to another account at once. A pool
// proxy failure is not one: the pool has moved the account to another proxy.
func outboundProxyFailure(err error) (string, bool) {
	if err == nil || proxypool.IsProxyError(err) {
		return "", false
	}
	return proxypool.DescribeProxyFailure(err)
}

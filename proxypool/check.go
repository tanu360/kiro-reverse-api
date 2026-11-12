package proxypool

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"
)

const (
	checkDialTimeout  = 5 * time.Second
	checkTLSTimeout   = 8 * time.Second
	checkTotalTimeout = 10 * time.Second
)

var (
	// checkTarget is the Kiro host every check reaches through the proxy.
	checkTarget = "https://q.us-east-1.amazonaws.com/"
	// checkTLS is nil (system roots) outside tests.
	checkTLS *tls.Config
)

// SetCheckTargetForTest points health checks at target and returns the restore.
func SetCheckTargetForTest(target string, tlsConfig *tls.Config) func() {
	prevTarget, prevTLS := checkTarget, checkTLS
	checkTarget, checkTLS = target, tlsConfig
	return func() { checkTarget, checkTLS = prevTarget, prevTLS }
}

// checkProxy sends one HEAD to the Kiro host through the proxy, on a fresh
// connection. Any HTTP answer from the host means the route works; the latency
// is the time to its response headers.
func checkProxy(ctx context.Context, fullURL string) (time.Duration, error) {
	proxyURL, err := url.Parse(fullURL)
	if err != nil {
		return 0, &ProxyError{Kind: KindConnect, cause: err}
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyURL(proxyURL),
		DialContext:           (&net.Dialer{Timeout: checkDialTimeout}).DialContext,
		TLSHandshakeTimeout:   checkTLSTimeout,
		ResponseHeaderTimeout: checkTotalTimeout,
		TLSClientConfig:       checkTLS,
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()

	ctx, cancel := context.WithTimeout(ctx, checkTotalTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, checkTarget, nil)
	if err != nil {
		return 0, &ProxyError{Kind: KindConnect, cause: err}
	}
	start := time.Now()
	resp, err := transport.RoundTrip(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return 0, &ProxyError{Kind: KindTimeout, cause: err}
		}
		return 0, newProxyError("", err)
	}
	latency := time.Since(start)
	resp.Body.Close()
	if resp.StatusCode == http.StatusProxyAuthRequired {
		return 0, &ProxyError{Kind: KindAuth, cause: errors.New(resp.Status)}
	}
	return latency, nil
}

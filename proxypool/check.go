package proxypool

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	checkDialTimeout  = 5 * time.Second
	checkTLSTimeout   = 8 * time.Second
	checkTotalTimeout = 10 * time.Second
)

var (
	// checkMu guards checkTarget and checkTLS: a test swaps them while background checks read them.
	checkMu sync.RWMutex
	// checkTarget is the Kiro host every check reaches through the proxy.
	checkTarget = "https://q.us-east-1.amazonaws.com/"
	// checkTLS is nil (system roots) outside tests.
	checkTLS *tls.Config
)

// SetCheckTargetForTest points health checks at target and returns the restore.
func SetCheckTargetForTest(target string, tlsConfig *tls.Config) func() {
	checkMu.Lock()
	prevTarget, prevTLS := checkTarget, checkTLS
	checkTarget, checkTLS = target, tlsConfig
	checkMu.Unlock()
	return func() {
		checkMu.Lock()
		checkTarget, checkTLS = prevTarget, prevTLS
		checkMu.Unlock()
	}
}

// SetMaxFailuresForTest makes n failures in a row disable a pool proxy and returns the restore.
func SetMaxFailuresForTest(n int) func() {
	prev := failureThreshold
	failureThreshold = n
	return func() { failureThreshold = prev }
}

func checkDestination() (string, *tls.Config) {
	checkMu.RLock()
	defer checkMu.RUnlock()
	return checkTarget, checkTLS
}

// checkProxy sends one HEAD to the Kiro host through the proxy, on a fresh
// connection. Any HTTP answer from the host means the route works; the latency
// is the time to its response headers.
func checkProxy(ctx context.Context, fullURL string) (time.Duration, error) {
	proxyURL, err := url.Parse(fullURL)
	if err != nil {
		return 0, &ProxyError{Kind: KindConnect, cause: err}
	}
	target, tlsConfig := checkDestination()
	transport := &http.Transport{
		Proxy:                 http.ProxyURL(proxyURL),
		DialContext:           (&net.Dialer{Timeout: checkDialTimeout}).DialContext,
		TLSHandshakeTimeout:   checkTLSTimeout,
		ResponseHeaderTimeout: checkTotalTimeout,
		TLSClientConfig:       tlsConfig,
		DisableKeepAlives:     true,
	}
	KeepConnectAnswer(transport)
	defer transport.CloseIdleConnections()

	ctx, cancel := context.WithTimeout(ctx, checkTotalTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
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
		return 0, &ProxyError{Kind: answerKind(resp.StatusCode, proxyURL.User != nil), cause: errors.New(resp.Status)}
	}
	return latency, nil
}

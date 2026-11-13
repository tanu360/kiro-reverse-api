package proxy

import (
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"kiro-proxy/logger"
	"kiro-proxy/proxypool"
)

const (
	//! Without its own dial timeout a pool proxy that drops packets would hold a request for
	//! the OS connect timeout (about two minutes) before the pool could move the account.
	poolDialTimeout = 10 * time.Second
	poolTLSTimeout  = 10 * time.Second
)

// poolClients caches one stream and one REST client per pool proxy, keyed by
// kind and dial URL; an edit changes the URL, and OnChange drops them all.
var poolClients sync.Map

// noHealthyClient answers every request at once with the pool's no-healthy error.
var noHealthyClient = &http.Client{Transport: noHealthyTransport{}}

type noHealthyTransport struct{}

func (noHealthyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
	return nil, proxypool.NoHealthyError()
}

func init() {
	pool := proxypool.Default()
	pool.OnChange(dropPoolClients)
	//! Health flips and assignment moves change what Settings and the account detail show.
	pool.OnStateChange(func() { publishEvent(eventSettingsChanged, "proxy-pool") })
}

func dropPoolClients() {
	poolClients.Range(func(key, value any) bool {
		poolClients.Delete(key)
		//! Idle connections only: a stream still reading keeps its client until it ends.
		value.(*http.Client).CloseIdleConnections()
		return true
	})
}

// poolClientFor returns the client for a pool route: the fail-fast client for
// UnavailableURL, or an instrumented client for a pool proxy's URL. ok is false
// for any other URL, which keeps the existing client caches.
func poolClientFor(proxyURL string, stream bool) (*http.Client, bool) {
	if proxyURL == "" {
		return nil, false
	}
	if proxyURL == proxypool.UnavailableURL {
		return noHealthyClient, true
	}
	p, ok := proxypool.Default().LookupURL(proxyURL)
	if !ok {
		return nil, false
	}
	key := "rest|" + p.ID + "|" + proxyURL
	if stream {
		key = "stream|" + p.ID + "|" + proxyURL
	}
	if cached, found := poolClients.Load(key); found {
		return cached.(*http.Client), true
	}
	var client *http.Client
	if stream {
		client = newKiroStreamClient(proxyURL)
	} else {
		client = &http.Client{Timeout: 30 * time.Second, Transport: buildKiroTransport(proxyURL)}
	}
	if transport, isTransport := client.Transport.(*http.Transport); isTransport {
		transport.DialContext = (&net.Dialer{Timeout: poolDialTimeout, KeepAlive: 30 * time.Second}).DialContext
		transport.TLSHandshakeTimeout = poolTLSTimeout
	}
	client.Transport = proxypool.Instrument(p.ID, proxyURL, client.Transport)
	actual, _ := poolClients.LoadOrStore(key, client)
	return actual.(*http.Client), true
}

// isNoHealthyProxyError is a request the pool had no proxy for: retrying the
// same account cannot help until a proxy recovers.
func isNoHealthyProxyError(err error) bool {
	return proxypool.IsNoHealthy(err)
}

// noHealthyWarnEvery spaces the warning about requests failing for want of a pool proxy.
const noHealthyWarnEvery = time.Minute

var lastNoHealthyWarn atomic.Int64

// noHealthyProxyFailure is the error of an attempt the pool had no proxy for,
// without the upstream URL the transport error repeats. Each account of each
// request hits it, so it warns at most once per noHealthyWarnEvery.
func noHealthyProxyFailure() error {
	now := time.Now().UnixNano()
	last := lastNoHealthyWarn.Load()
	if now-last >= int64(noHealthyWarnEvery) && lastNoHealthyWarn.CompareAndSwap(last, now) {
		logger.Warnf("[ProxyPool] Requests are failing: no pool proxy is healthy and direct fallback is off")
	}
	return proxypool.NoHealthyError()
}

// upstreamErrorText is the error text a client gets. A pool proxy failure reads
// as its fixed wording, without the upstream URL the transport error repeats.
func upstreamErrorText(err error) string {
	var perr *proxypool.ProxyError
	if errors.As(err, &perr) {
		return perr.Error()
	}
	return err.Error()
}

// poolAwareStatus is fallback, or 503 for a request that failed at its pool
// proxy or found none, as upstreamFailureStatus answers on the chat paths.
func poolAwareStatus(err error, fallback int) int {
	if proxypool.IsProxyError(err) {
		return http.StatusServiceUnavailable
	}
	return fallback
}

// startProxyPool loads the saved pool state and starts the periodic health check.
func startProxyPool() {
	proxypool.Default().Load()
	proxypool.Default().Start()
}

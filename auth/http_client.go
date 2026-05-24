package auth

import (
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

var httpClientStore atomic.Pointer[http.Client]

var authProxyClientCache sync.Map

func httpClient() *http.Client {
	return httpClientStore.Load()
}

func init() {
	InitHttpClient("")
}

func GetAuthClientForProxy(proxyURL string) *http.Client {
	if proxyURL == "" {
		return httpClient()
	}
	if cached, ok := authProxyClientCache.Load(proxyURL); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildAuthTransport(proxyURL),
	}
	authProxyClientCache.Store(proxyURL, client)
	return client
}

func buildAuthTransport(proxyURL string) *http.Transport {
	t := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
		ForceAttemptHTTP2:   true,
	}
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil {
			t.Proxy = http.ProxyURL(u)
			t.ForceAttemptHTTP2 = false
		}
	} else {
		t.Proxy = http.ProxyFromEnvironment
	}
	return t
}

func InitHttpClient(proxyURL string) {
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildAuthTransport(proxyURL),
	}
	httpClientStore.Store(client)
}

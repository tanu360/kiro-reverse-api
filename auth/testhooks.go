package auth

import "net/http"

func SetOIDCTokenURLForTest(fn func(region string) string) {
	if fn == nil {
		return
	}
	oidcTokenURL = fn
}

func GetOIDCTokenURLForTest() func(region string) string {
	return oidcTokenURL
}

func SetGlobalAuthClientForTest(c *http.Client) *http.Client {
	old := httpClientStore.Load()
	if c != nil {
		httpClientStore.Store(c)
	}
	return old
}

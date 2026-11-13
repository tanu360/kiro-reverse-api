package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func TestMaskAndRestoreProxyPassword(t *testing.T) {
	cases := []struct{ raw, masked string }{
		{"", ""},
		{"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"http://user@10.0.0.1:3128", "http://user@10.0.0.1:3128"},
		{"http://user:@10.0.0.1:3128", "http://user:@10.0.0.1:3128"},
		{"socks5://suser:s3cret@127.0.0.1:1080", "socks5://suser:" + maskedProxyPassword + "@127.0.0.1:1080"},
		{"http://u:p%40ss@[::1]:8080", "http://u:" + maskedProxyPassword + "@[::1]:8080"},
		// An unescaped / or @ in the password still sits inside the userinfo.
		{"http://u:pa/ss@host:1", "http://u:" + maskedProxyPassword + "@host:1"},
		{"http://u:pa@ss@host:1", "http://u:" + maskedProxyPassword + "@host:1"},
	}
	for _, tc := range cases {
		if got := maskProxyURL(tc.raw); got != tc.masked {
			t.Errorf("mask %q = %q, want %q", tc.raw, got, tc.masked)
		}
		if got, err := restoreProxyPassword(maskProxyURL(tc.raw), tc.raw); err != nil || got != tc.raw {
			t.Errorf("restore %q = %q, %v", tc.raw, got, err)
		}
	}

	stored := "socks5://suser:s3cret@127.0.0.1:1080"
	if got, _ := restoreProxyPassword("socks5://suser:"+maskedProxyPassword+"@10.0.0.2:1080", stored); got != "socks5://suser:s3cret@10.0.0.2:1080" {
		t.Errorf("a host edit lost the password: %q", got)
	}
	if got, _ := restoreProxyPassword("socks5://suser:new-pw@127.0.0.1:1080", stored); got != "socks5://suser:new-pw@127.0.0.1:1080" {
		t.Errorf("a typed password was replaced: %q", got)
	}
	if _, err := restoreProxyPassword("socks5://suser:"+maskedProxyPassword+"@127.0.0.1:1080", "socks5://127.0.0.1:1080"); err == nil {
		t.Error("the mask was saved as a password where none is stored")
	}
}

func accountProxyFromList(t *testing.T, h *Handler, id string) string {
	t.Helper()
	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/accounts", "")
	var list []map[string]interface{}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &list) != nil {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("the account list leaks a proxy password: %s", rec.Body.String())
	}
	for _, a := range list {
		if a["id"] == id {
			proxyURL, _ := a["proxyURL"].(string)
			return proxyURL
		}
	}
	t.Fatalf("account %s not listed", id)
	return ""
}

func storedAccountProxy(t *testing.T, id string) string {
	t.Helper()
	for _, a := range config.GetAccounts() {
		if a.ID == id {
			return a.ProxyURL
		}
	}
	t.Fatalf("account %s not stored", id)
	return ""
}

// The account list masks an account's own proxy password, and saving the URL it shows (as is,
// or with only the host changed) keeps the stored password.
func TestAccountProxyURLMaskedAndKept(t *testing.T) {
	h := newRegionTestAdmin(t)
	const secretURL = "socks5://suser:s3cret@127.0.0.1:19404"
	acc := config.Account{ID: "acc-px", Email: "px@example.com", Enabled: true, AuthMethod: "social", ProxyURL: secretURL}
	if err := config.AddAccount(acc); err != nil {
		t.Fatal(err)
	}

	shown := accountProxyFromList(t, h, acc.ID)
	if shown != "socks5://suser:"+maskedProxyPassword+"@127.0.0.1:19404" {
		t.Fatalf("listed proxy %q", shown)
	}
	put := func(body string) int {
		t.Helper()
		return serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/"+acc.ID, body).Code
	}
	if code := put(`{"proxyURL":"` + shown + `"}`); code != http.StatusOK {
		t.Fatalf("save as shown: %d", code)
	}
	if got := storedAccountProxy(t, acc.ID); got != secretURL {
		t.Fatalf("saving the masked URL stored %q", got)
	}
	moved := strings.Replace(shown, "127.0.0.1:19404", "127.0.0.1:19405", 1)
	if code := put(`{"proxyURL":"` + moved + `"}`); code != http.StatusOK {
		t.Fatalf("host edit: %d", code)
	}
	if got := storedAccountProxy(t, acc.ID); got != "socks5://suser:s3cret@127.0.0.1:19405" {
		t.Fatalf("a host edit stored %q", got)
	}

	// A bad URL is refused before any field changes.
	rec := serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/"+acc.ID, `{"nickname":"renamed","proxyURL":"127.0.0.1:19403"}`)
	if rec.Code != http.StatusBadRequest || adminErrorCode(t, rec.Body.Bytes()) != codeProxyURLScheme {
		t.Fatalf("host:port: %d %s", rec.Code, rec.Body.String())
	}
	for _, a := range config.GetAccounts() {
		if a.ID == acc.ID && (a.Nickname != "" || a.ProxyURL != "socks5://suser:s3cret@127.0.0.1:19405") {
			t.Fatalf("a refused update changed the account: %+v", a)
		}
	}

	if code := put(`{"proxyURL":""}`); code != http.StatusOK || storedAccountProxy(t, acc.ID) != "" {
		t.Fatalf("clear: %d, stored %q", code, storedAccountProxy(t, acc.ID))
	}
	rec = serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/"+acc.ID, `{"proxyURL":"`+shown+`"}`)
	if rec.Code != http.StatusBadRequest || adminErrorCode(t, rec.Body.Bytes()) != codeProxyPasswordMasked {
		t.Fatalf("mask with nothing stored: %d %s", rec.Code, rec.Body.String())
	}
}

// The global proxy answers with its password masked, and the mask sent back keeps it.
func TestGlobalProxyURLMaskedAndKept(t *testing.T) {
	h := newRegionTestAdmin(t)
	t.Cleanup(func() { applyProxyConfig("") })
	const secretURL = "http://guser:s3cret@127.0.0.1:19406"
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy", `{"proxyURL":"`+secretURL+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("set: %d %s", rec.Code, rec.Body.String())
	}
	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/proxy", "")
	var got struct {
		ProxyURL string `json:"proxyURL"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &got) != nil || strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("get leaks the password: %s", rec.Body.String())
	}
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy", `{"proxyURL":"`+got.ProxyURL+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("save as shown: %d %s", rec.Code, rec.Body.String())
	}
	if stored := config.GetProxyURL(); stored != secretURL {
		t.Fatalf("saving the masked URL stored %q", stored)
	}
}

// Account and global proxy URLs are checked like pool URLs: a host, and a port in range.
func TestProxyURLsNeedAHostAndAValidPort(t *testing.T) {
	h := newRegionTestAdmin(t)
	t.Cleanup(func() { applyProxyConfig("") })
	for _, bad := range []string{"http://", "http://127.0.0.1:99999", "http://exa mple.com:80", "http://1.2.3.4:8080:9"} {
		rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy", `{"proxyURL":"`+bad+`"}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"proxy_url_invalid"`) {
			t.Fatalf("global %q: %d %s", bad, rec.Code, rec.Body.String())
		}
		if _, _, err := accountProxyURLUpdate(map[string]interface{}{"proxyURL": bad}, ""); err == nil {
			t.Fatalf("account %q accepted", bad)
		}
	}
	if config.GetProxyURL() != "" {
		t.Fatalf("a refused URL was saved: %q", config.GetProxyURL())
	}
	if _, ok, err := accountProxyURLUpdate(map[string]interface{}{"proxyURL": "socks5://127.0.0.1:1080"}, ""); !ok || err != nil {
		t.Fatalf("a good URL was refused: %v", err)
	}
}

package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/proxypool"
)

// newPoolTestAdmin is an admin handler on its own database with an empty, clean
// proxy pool. Health checks go to a host the fake proxies answer for.
func newPoolTestAdmin(t *testing.T) *Handler {
	t.Helper()
	h := newRegionTestAdmin(t)
	t.Cleanup(proxypool.SetCheckTargetForTest("http://kiro.test/", nil))
	proxypool.Default().ResetForTest()
	//! Runs before the check target is restored: it ends this test's background checks first.
	t.Cleanup(proxypool.Default().ResetForTest)
	t.Cleanup(dropPoolClients)
	return h
}

func poolClosedPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

// poolFakeProxy answers every proxied plain-HTTP request itself, as the upstream would.
func poolFakeProxy(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "upstream via "+r.Host)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func setPoolMode(t *testing.T, mode string, fallback bool) {
	t.Helper()
	if err := config.UpdateProxyPoolSettings(&mode, &fallback, nil); err != nil {
		t.Fatal(err)
	}
}

func addPoolTestAccount(t *testing.T, h *Handler, id string) *config.Account {
	t.Helper()
	acc := config.Account{ID: id, Email: id + "@example.com", Enabled: true, AuthMethod: "social", AccessToken: "token", RefreshToken: "refresh"}
	if err := config.AddAccount(acc); err != nil {
		t.Fatal(err)
	}
	h.pool.Reload()
	return &acc
}

func TestProxyPoolAPIMasksPassword(t *testing.T) {
	h := newPoolTestAdmin(t)
	addr := poolClosedPort(t)

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy-pool/proxies",
		fmt.Sprintf(`{"label":"Tokyo","url":"http://alice:s3cret-pw@%s"}`, addr))
	if rec.Code != http.StatusCreated {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("add response leaks the password: %s", rec.Body.String())
	}
	var added struct {
		Proxy proxypool.ProxyView `json:"proxy"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatal(err)
	}
	p := added.Proxy
	if p.ID == "" || p.URL != "http://"+addr || p.Username != "alice" || !p.HasPassword || p.Label != "Tokyo" {
		t.Fatalf("added view %+v", p)
	}

	rec = serveRegionTestAdmin(h, http.MethodGet, "/admin/api/proxy-pool", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "s3cret") || !strings.Contains(rec.Body.String(), p.ID) {
		t.Fatalf("view: %d %s", rec.Code, rec.Body.String())
	}

	// An edit without a password keeps it.
	rec = serveRegionTestAdmin(h, http.MethodPut, "/admin/api/proxy-pool/proxies/"+p.ID, `{"label":"Osaka"}`)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "s3cret") || !strings.Contains(rec.Body.String(), "Osaka") {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
	}
	if stored := config.GetProxyPool(); len(stored) != 1 || stored[0].Password != "s3cret-pw" {
		t.Fatalf("label edit lost the password: %+v", stored)
	}

	// An empty password clears it.
	rec = serveRegionTestAdmin(h, http.MethodPut, "/admin/api/proxy-pool/proxies/"+p.ID, `{"password":""}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"hasPassword":false`) {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}

	rec = serveRegionTestAdmin(h, http.MethodDelete, "/admin/api/proxy-pool/proxies/"+p.ID, "")
	if rec.Code != http.StatusOK || len(config.GetProxyPool()) != 0 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
}

func adminErrorCode(t *testing.T, body []byte) string {
	t.Helper()
	var resp struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return resp.Code
}

func TestProxyPoolAPIValidation(t *testing.T) {
	h := newPoolTestAdmin(t)
	addr := poolClosedPort(t)

	cases := []struct {
		method, path, body string
		status             int
		code               string
	}{
		{http.MethodPut, "/admin/api/proxy-pool/settings", `{"mode":"on"}`, http.StatusBadRequest, codeProxyPoolEmpty},
		{http.MethodPut, "/admin/api/proxy-pool/settings", `{"checkIntervalMin":5000}`, http.StatusBadRequest, codeProxyPoolInvalid},
		{http.MethodPut, "/admin/api/proxy-pool/settings", `{"mode":"sometimes"}`, http.StatusBadRequest, codeProxyPoolInvalid},
		{http.MethodPost, "/admin/api/proxy-pool/proxies", `{"url":"ftp://10.0.0.1:21"}`, http.StatusBadRequest, codeProxyPoolInvalid},
		{http.MethodPost, "/admin/api/proxy-pool/proxies", `{"url":"http://10.0.0.1"}`, http.StatusBadRequest, codeProxyPoolInvalid},
		{http.MethodPost, "/admin/api/proxy-pool/proxies", `{"url":"127.0.0.1:19403"}`, http.StatusBadRequest, codeProxyPoolInvalid},
		{http.MethodPost, "/admin/api/proxy-pool/proxies", `{"url":`, http.StatusBadRequest, codeInvalidJSON},
		{http.MethodPut, "/admin/api/proxy-pool/proxies/px_missing", `{"label":"x"}`, http.StatusNotFound, codeProxyPoolNotFound},
		{http.MethodDelete, "/admin/api/proxy-pool/proxies/px_missing", ``, http.StatusNotFound, codeProxyPoolNotFound},
		{http.MethodPost, "/admin/api/proxy-pool/proxies/px_missing/check", ``, http.StatusNotFound, codeProxyPoolNotFound},
	}
	for _, tc := range cases {
		rec := serveRegionTestAdmin(h, tc.method, tc.path, tc.body)
		if rec.Code != tc.status || adminErrorCode(t, rec.Body.Bytes()) != tc.code {
			t.Errorf("%s %s %s: %d %s, want %d %s", tc.method, tc.path, tc.body, rec.Code, rec.Body.String(), tc.status, tc.code)
		}
	}

	body := fmt.Sprintf(`{"url":"socks5://%s"}`, addr)
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy-pool/proxies", body); rec.Code != http.StatusCreated {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy-pool/proxies", body)
	if rec.Code != http.StatusConflict || adminErrorCode(t, rec.Body.Bytes()) != codeProxyPoolDuplicate {
		t.Fatalf("duplicate: %d %s", rec.Code, rec.Body.String())
	}

	rec = serveRegionTestAdmin(h, http.MethodPut, "/admin/api/proxy-pool/settings", `{"mode":"on","directFallback":true,"checkIntervalMin":0}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("settings: %d %s", rec.Code, rec.Body.String())
	}
	var view proxypool.View
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Mode != "on" || !view.DirectFallback || view.CheckIntervalMin != 0 || len(view.Proxies) != 1 {
		t.Fatalf("settings view %+v", view)
	}
}

func TestProxyPoolAPICheckOne(t *testing.T) {
	h := newPoolTestAdmin(t)
	live := poolFakeProxy(t)
	if err := config.SetProxyPool([]config.PoolProxy{{ID: "px_live", URL: live}}); err != nil {
		t.Fatal(err)
	}
	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/proxy-pool/proxies/px_live/check", "")
	var resp struct {
		Proxy proxypool.ProxyView `json:"proxy"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &resp) != nil {
		t.Fatalf("check: %d %s", rec.Code, rec.Body.String())
	}
	if resp.Proxy.Health.Status != proxypool.StatusOK || resp.Proxy.Health.CheckedAt == 0 {
		t.Fatalf("health %+v", resp.Proxy.Health)
	}
}

func TestPoolRotationOnDialFailureEndToEnd(t *testing.T) {
	h := newPoolTestAdmin(t)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t), Username: "u", Password: "dead-secret"}
	live := config.PoolProxy{ID: "px_live", URL: poolFakeProxy(t)}
	if err := config.SetProxyPool([]config.PoolProxy{dead, live}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	acc := addPoolTestAccount(t, h, "acc-pool")

	first := ResolveAccountProxyURL(acc)
	if first != proxypool.FullURL(dead) {
		t.Fatalf("first route %q, want the dead proxy", first)
	}
	_, err := GetRestClientForProxy(first).Get("http://kiro.test/generateAssistantResponse")
	if !proxypool.IsProxyError(err) {
		t.Fatalf("dead proxy: %v, want a ProxyError", err)
	}
	if strings.Contains(err.Error(), "dead-secret") {
		t.Fatalf("error text leaks the proxy password: %v", err)
	}
	if got := upstreamFailureStatus(err); got != http.StatusServiceUnavailable {
		t.Fatalf("client status %d, want 503", got)
	}

	// The account is not penalized: three failures would cool it down for a minute.
	for i := 0; i < 3; i++ {
		h.handleAccountFailure(acc, err)
	}
	if until := h.pool.CooldownUntil(acc.ID); !until.IsZero() {
		t.Fatalf("a proxy failure cooled the account down until %v", until)
	}
	for _, a := range config.GetAccounts() {
		if a.ID == acc.ID && (!a.Enabled || a.BanStatus != "") {
			t.Fatalf("a proxy failure disabled the account: %+v", a)
		}
	}
	if !newRequestRetryPlan().canRetrySameAccount(err, 0, 1) && newRequestRetryPlan().maxPerAccount > 1 {
		t.Fatal("a rotated account should be retried on its new proxy")
	}

	second := ResolveAccountProxyURL(acc)
	if second != proxypool.FullURL(live) {
		t.Fatalf("route after the failure %q, want the live proxy", second)
	}
	resp, err := GetClientForProxy(second).Get("http://kiro.test/generateAssistantResponse")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "kiro.test") {
		t.Fatalf("live proxy: %d %s", resp.StatusCode, body)
	}
}

func TestNoHealthyProxyClientFailsFast(t *testing.T) {
	h := newPoolTestAdmin(t)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t)}
	if err := config.SetProxyPool([]config.PoolProxy{dead}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	acc := addPoolTestAccount(t, h, "acc-none")
	proxypool.Default().ReportFailure(dead.ID, errors.New("connect: connection refused"))

	route := ResolveAccountProxyURL(acc)
	if route != proxypool.UnavailableURL {
		t.Fatalf("route %q, want UnavailableURL", route)
	}
	start := time.Now()
	_, err := GetClientForProxy(route).Get("https://kiro.test/generateAssistantResponse")
	if !proxypool.IsNoHealthy(err) || time.Since(start) > time.Second {
		t.Fatalf("no-healthy client: %v after %s", err, time.Since(start))
	}
	if _, err := GetRestClientForProxy(route).Get("https://kiro.test/x"); !proxypool.IsNoHealthy(err) {
		t.Fatalf("REST client: %v", err)
	}
	plan := newRequestRetryPlan()
	if plan.canRetrySameAccount(err, 0, 1) || plan.shouldBackoffBeforeNextAccount(err, 1) {
		t.Fatal("a request with no proxy to go through was retried on the same account")
	}
	if upstreamFailureStatus(err) != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", upstreamFailureStatus(err))
	}

	// With direct fallback the account goes on down the route instead.
	setPoolMode(t, config.ProxyPoolModeOn, true)
	if got := ResolveAccountProxyURL(acc); got != config.GetProxyURL() {
		t.Fatalf("fallback route %q, want the global route %q", got, config.GetProxyURL())
	}
}

func TestPoolClientRebuiltAfterEdit(t *testing.T) {
	newPoolTestAdmin(t)
	live := poolFakeProxy(t)
	p, err := proxypool.Default().Add(proxypool.ProxyInput{URL: &live})
	if err != nil {
		t.Fatal(err)
	}
	full := proxypool.FullURL(p)
	first := GetClientForProxy(full)
	if GetClientForProxy(full) != first || GetRestClientForProxy(full) == first {
		t.Fatal("pool clients are not cached per proxy and kind")
	}
	label := "renamed"
	if _, err := proxypool.Default().Update(p.ID, proxypool.ProxyInput{Label: &label}); err != nil {
		t.Fatal(err)
	}
	if GetClientForProxy(full) == first {
		t.Fatal("an edit kept the old client")
	}
	// An account's own proxy that is not in the pool keeps the plain client cache.
	if c, ok := poolClientFor("http://own.example:8080", true); ok || c != nil {
		t.Fatal("a non-pool URL went through the pool clients")
	}
}

// A usage refresh that cannot reach Kiro through the pool must not ban the
// account, even though the error repeats a URL whose profile ARN holds "403".
func TestUsageRefreshProxyFailureDoesNotBan(t *testing.T) {
	h := newPoolTestAdmin(t)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t)}
	if err := config.SetProxyPool([]config.PoolProxy{dead}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	acc := config.Account{ID: "acc-arn", Email: "arn@example.com", Enabled: true, AuthMethod: "idc",
		AccessToken: "token", RefreshToken: "refresh",
		ProfileArn: "arn:aws:codewhisperer:us-east-1:540312340301:profile/ABCDEF"}
	if err := config.AddAccount(acc); err != nil {
		t.Fatal(err)
	}
	h.pool.Reload()

	check := func(stage string) {
		t.Helper()
		_, err := RefreshAccountInfo(&acc)
		if err == nil || !strings.Contains(err.Error(), "403") {
			t.Fatalf("%s: refresh error %v, want a transport error whose URL holds 403", stage, err)
		}
		for _, a := range config.GetAccounts() {
			if a.ID == acc.ID && (!a.Enabled || a.BanStatus != "") {
				t.Fatalf("%s: a proxy failure banned the account: enabled=%v ban=%q", stage, a.Enabled, a.BanStatus)
			}
		}
	}
	check("dead proxy")
	// The dead proxy is now failed, so the pool has none left: the fail-fast client answers.
	if got := ResolveAccountProxyURL(&acc); got != proxypool.UnavailableURL {
		t.Fatalf("route %q, want UnavailableURL", got)
	}
	check("no healthy proxy")
}

// With no pool proxy up, a chat attempt stops at the first endpoint and the client sees the
// pool's own wording, not the upstream URL the transport error repeats.
func TestNoHealthyProxyChatFailsOnceWithoutURL(t *testing.T) {
	h := newPoolTestAdmin(t)
	dead := config.PoolProxy{ID: "px_dead", URL: "http://" + poolClosedPort(t), Username: "u", Password: "pool-secret"}
	if err := config.SetProxyPool([]config.PoolProxy{dead}); err != nil {
		t.Fatal(err)
	}
	setPoolMode(t, config.ProxyPoolModeOn, false)
	acc := addPoolTestAccount(t, h, "acc-chat")
	acc.ProfileArn = "arn:aws:codewhisperer:us-east-1:540312340301:profile/ABCDEF"
	proxypool.Default().ReportFailure(dead.ID, errors.New("connect: connection refused"))

	var payload KiroPayload
	payload.ConversationState.CurrentMessage.UserInputMessage.Content = "hi"
	start := time.Now()
	err := callKiroAPIContextOnce(t.Context(), acc, &payload, &KiroStreamCallback{})
	if !proxypool.IsNoHealthy(err) || time.Since(start) > time.Second {
		t.Fatalf("chat: %v after %s, want the no-healthy error at once", err, time.Since(start))
	}
	// A REST call (usage, MCP search) gets the transport's url.Error, which repeats the URL.
	transport := &neturl.Error{Op: "Post", URL: "https://q.us-east-1.amazonaws.com/generateAssistantResponse", Err: proxypool.NoHealthyError()}
	text := upstreamErrorText(fmt.Errorf("wrapped: %w", transport))
	for _, leak := range []string{"https://", "amazonaws", "pool-secret", "kiro.dev"} {
		if strings.Contains(err.Error(), leak) || strings.Contains(text, leak) {
			t.Fatalf("client text %q / %q holds %q", err.Error(), text, leak)
		}
	}
	if text != proxypool.ErrNoHealthyProxy.Error() {
		t.Fatalf("client text %q", text)
	}
}

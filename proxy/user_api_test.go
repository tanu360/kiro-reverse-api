package proxy

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/tunnel"
)

func newUserAPITestHandler(t *testing.T) *Handler {
	t.Helper()
	resetObservePersistenceForTest(t)
	return newRoutedHandlerForTest(t).(*Handler)
}

func userCall(h http.Handler, method, target, token, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	req.RemoteAddr = "192.0.2.10:1234"
	if token != "" {
		req.Header.Set("X-User-Token", token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func userSignIn(t *testing.T, h http.Handler, key string) string {
	t.Helper()
	rec := userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"`+key+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Token) != 64 {
		t.Fatalf("token %q, want 64 hex", body.Token)
	}
	want := time.Now().Add(userSessionTTL).Unix()
	if body.ExpiresAt < want-5 || body.ExpiresAt > want+5 {
		t.Fatalf("expiresAt %d, want unix seconds near %d", body.ExpiresAt, want)
	}
	return body.Token
}

func userJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func assertUserError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	if got := userJSON(t, rec)["code"]; got != code {
		t.Fatalf("code %v, want %s", got, code)
	}
}

func userFieldNames(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func assertKeySet(t *testing.T, what string, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := userFieldNames(m); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%s fields %v, want %v", what, got, want)
	}
}

func TestUserSessionSignIn(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-signin-0123456789abcdef", true)

	userSignIn(t, h, key.Key)
	userSignIn(t, h, "  "+key.Key+"\\n")
	assertUserError(t, userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"  "}`), http.StatusBadRequest, codeUserKeyRequired)
	assertUserError(t, userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"sk-user-signin-0123456789abcdeX"}`), http.StatusUnauthorized, codeUserKeyInvalid)
}

// The lockout counts only the user panel's failures, and its 429 looks exactly like the admin
// sign-in's, so the UI's rate-limit handling works for both.
func TestUserSessionLockoutMatchesAdmin(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-lockout-0123456789abcdef", true)

	attempt := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.RemoteAddr = "192.0.2.20:4000"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for i := 0; i < adminGuessesPerClient; i++ {
		assertUserError(t, attempt("/user/api/session", `{"key":"sk-wrong"}`), http.StatusUnauthorized, codeUserKeyInvalid)
	}
	user := attempt("/user/api/session", `{"key":"`+key.Key+`"}`)
	if user.Code != http.StatusTooManyRequests {
		t.Fatalf("locked out client signed in: %d", user.Code)
	}
	if rec := attempt("/admin/api/session", `{"password":"wrong"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("user failures locked the admin sign-in: %d", rec.Code)
	}
	for i := 0; i < adminGuessesPerClient; i++ {
		attempt("/admin/api/session", `{"password":"wrong"}`)
	}
	admin := attempt("/admin/api/session", `{"password":"wrong"}`)
	if admin.Code != http.StatusTooManyRequests {
		t.Fatalf("admin not locked out: %d", admin.Code)
	}
	for _, name := range []string{"Retry-After", "Content-Type"} {
		if user.Header().Get(name) == "" || user.Header().Get(name) != admin.Header().Get(name) {
			t.Fatalf("%s: user %q, admin %q", name, user.Header().Get(name), admin.Header().Get(name))
		}
	}
	assertKeySet(t, "429 body", userJSON(t, user), userFieldNames(userJSON(t, admin))...)
}

func TestUserSessionDisabledAndExpiredKeysSignIn(t *testing.T) {
	h := newUserAPITestHandler(t)
	disabled := addUsageKey(t, "off", "sk-user-disabled-0123456789abcdef", false)
	expired, err := config.AddApiKey(config.ApiKeyEntry{Name: "old", Key: "sk-user-expired-0123456789abcdef", Enabled: true, ExpiresAt: time.Now().Add(-time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}

	body := userJSON(t, userCall(h, http.MethodGet, "/user/api/key", userSignIn(t, h, disabled.Key), ""))
	if body["id"] != disabled.ID || body["enabled"] != false {
		t.Fatalf("disabled key view %v", body)
	}
	body = userJSON(t, userCall(h, http.MethodGet, "/user/api/key", userSignIn(t, h, expired.Key), ""))
	if body["id"] != expired.ID || body["expired"] != true {
		t.Fatalf("expired key view %v", body)
	}
}

func TestUserSessionEnds(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-ends-0123456789abcdef", true)
	get := func(token string) *httptest.ResponseRecorder {
		return userCall(h, http.MethodGet, "/user/api/key", token, "")
	}

	assertUserError(t, get(""), http.StatusUnauthorized, codeUserSessionExpired)
	assertUserError(t, get(strings.Repeat("0", 64)), http.StatusUnauthorized, codeUserSessionExpired)

	token := userSignIn(t, h, key.Key)
	h.userSessions.mu.Lock()
	session := h.userSessions.sessions[token]
	session.expiry = time.Now().Add(-time.Second)
	h.userSessions.sessions[token] = session
	h.userSessions.mu.Unlock()
	assertUserError(t, get(token), http.StatusUnauthorized, codeUserSessionExpired)

	token = userSignIn(t, h, key.Key)
	if rec := userCall(h, http.MethodDelete, "/user/api/session", token, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("sign out: %d", rec.Code)
	}
	assertUserError(t, get(token), http.StatusUnauthorized, codeUserSessionExpired)

	token = userSignIn(t, h, key.Key)
	fresh, err := config.RegenerateApiKey(key.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertUserError(t, get(token), http.StatusUnauthorized, codeUserSessionExpired)
	assertUserError(t, userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"`+key.Key+`"}`), http.StatusUnauthorized, codeUserKeyInvalid)

	token = userSignIn(t, h, fresh.Key)
	if rec := get(token); rec.Code != http.StatusOK {
		t.Fatalf("new value: %d", rec.Code)
	}
	if err := config.DeleteApiKey(key.ID); err != nil {
		t.Fatal(err)
	}
	assertUserError(t, get(token), http.StatusUnauthorized, codeUserSessionExpired)
}

// One key's sign-in loop evicts its own oldest session, never another key's.
func TestUserSessionCapPerKey(t *testing.T) {
	var s userSessionStore
	busy := config.ApiKeyEntry{ID: "busy", Key: "sk-busy"}
	quiet := config.ApiKeyEntry{ID: "quiet", Key: "sk-quiet"}
	quietToken, _, err := s.issue(quiet)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxUserSessionsPerKey*3; i++ {
		if _, _, err := s.issue(busy); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.sessions) != maxUserSessionsPerKey+1 {
		t.Fatalf("%d sessions, want %d", len(s.sessions), maxUserSessionsPerKey+1)
	}
	if _, ok := s.sessions[quietToken]; !ok {
		t.Fatal("another key's sign-ins evicted this key's session")
	}
}

func TestUserKeyViewFields(t *testing.T) {
	h := newUserAPITestHandler(t)
	entry, err := config.AddApiKey(config.ApiKeyEntry{
		Key: "sk-user-view-0123456789abcdef", Enabled: true,
		AccountTags: []string{"secret-tag"}, RoutingMode: "weighted",
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := userCall(h, http.MethodGet, "/user/api/key", userSignIn(t, h, entry.Key), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("key: %d %s", rec.Code, rec.Body.String())
	}
	body := userJSON(t, rec)
	assertKeySet(t, "key", body,
		"id", "name", "keyMasked", "enabled", "expired", "createdAt", "lastUsedAt", "expiresAt",
		"tokenLimit", "tokensUsed", "creditLimit", "creditsUsed", "callLimit", "successfulCalls",
		"requestsCount", "rpmLimit", "allowedModels", "keysRequired")
	if body["keysRequired"] != config.IsApiKeyRequired() {
		t.Fatalf("keysRequired %v, want the server's setting %v", body["keysRequired"], config.IsApiKeyRequired())
	}
	if models, ok := body["allowedModels"].([]any); !ok || len(models) != 0 {
		t.Fatalf("allowedModels %v, want []", body["allowedModels"])
	}
	if body["keyMasked"] != config.MaskApiKey(entry.Key) || strings.Contains(rec.Body.String(), entry.Key) {
		t.Fatalf("key view shows %s", rec.Body.String())
	}
}

func TestUserRequestsOnlyOwnKey(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-mine-0123456789abcdef", true)
	other := addUsageKey(t, "other", "sk-user-other-0123456789abcdef", true)
	s := getObserveStore()
	s.RecordRequestWithAPIKey("acc-secret", mine.ID, mine.Key, "owner@example.com", "model-a", 10, 5, 0.1, true, 200, "")
	s.RecordRequestWithAPIKey("acc-secret", mine.ID, mine.Key, "owner@example.com", "model-a", 3, 0, 0, false, 429, "upstream secret message")
	s.RecordRequestWithAPIKey("acc-secret", other.ID, other.Key, "owner@example.com", "model-b", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("acc-secret", "owner@example.com", "model-c", 1, 1, 0.01, true, 200, "")
	token := userSignIn(t, h, mine.Key)

	rec := userCall(h, http.MethodGet, "/user/api/requests", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("requests: %d %s", rec.Code, rec.Body.String())
	}
	for _, leak := range []string{"acc-secret", "owner@example.com", "upstream secret message", other.ID, "model-b", "model-c"} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Fatalf("requests leak %q: %s", leak, rec.Body.String())
		}
	}
	body := userJSON(t, rec)
	assertKeySet(t, "page", body, "requests", "total", "page", "pageSize", "sort", "order", "counts")
	if counts := body["counts"].(map[string]any); counts["all"] != float64(2) || counts["succeeded"] != float64(1) || counts["failed"] != float64(1) {
		t.Fatalf("counts %v, want this key's 2 requests, 1 failed", counts)
	}
	rows := body["requests"].([]any)
	if body["total"] != float64(2) || len(rows) != 2 || body["pageSize"] != float64(25) {
		t.Fatalf("page %v", body)
	}
	for _, row := range rows {
		assertKeySet(t, "request", row.(map[string]any),
			"ts", "model", "endpoint", "inTokens", "outTokens", "totalTokens", "cacheReadTokens",
			"cacheWriteTokens", "credits", "success", "status", "durationMs", "errorType", "requestId")
	}
	if first := rows[0].(map[string]any); first["success"] != false || first["status"] != float64(429) {
		t.Fatalf("newest first: %v", rows)
	}

	for status, want := range map[string]float64{"error": 1, "success": 1, "all": 2} {
		page := userJSON(t, userCall(h, http.MethodGet, "/user/api/requests?status="+status, token, ""))
		if page["total"] != want {
			t.Fatalf("status=%s total %v, want %v", status, page["total"], want)
		}
	}
	page := userJSON(t, userCall(h, http.MethodGet, "/user/api/requests?page=2&pageSize=1", token, ""))
	if page["total"] != float64(2) || len(page["requests"].([]any)) != 1 || page["page"] != float64(2) {
		t.Fatalf("paging %v", page)
	}
	if page := userJSON(t, userCall(h, http.MethodGet, "/user/api/requests?pageSize=500", token, "")); page["pageSize"] != float64(maxUserRequestsPageSize) {
		t.Fatalf("pageSize %v", page["pageSize"])
	}

	memory := s.memoryRequestPage(normalizeRequestQuery(requestQuery{APIKeyID: mine.ID}))
	if memory.Total != 2 {
		t.Fatalf("memory page total %d, want 2", memory.Total)
	}
	for _, rec := range memory.Requests {
		if rec.APIKeyID != mine.ID {
			t.Fatalf("memory page holds key %q", rec.APIKeyID)
		}
	}
}

func TestUserUsageOnlyOwnKey(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-usage-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-usage-other-0123456789", true)
	idle := addUsageKey(t, "idle", "sk-user-usage-idle-0123456789", true)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Unix() - 600
	for _, row := range []struct {
		keyID, model string
		success      int
	}{{mine.ID, "model-a", 1}, {mine.ID, "model-a", 0}, {other.ID, "model-b", 1}, {"", "model-c", 1}} {
		if _, err := d.Exec(`INSERT INTO requests (ts, account_id, api_key_id, model, in_tokens, out_tokens, total_tokens, credits, success) VALUES (?, 'acc-secret', ?, ?, 10, 5, 15, 0.5, ?)`,
			ts, row.keyID, row.model, row.success); err != nil {
			t.Fatal(err)
		}
	}
	token := userSignIn(t, h, mine.Key)

	var usage apiKeyUsageResponse
	rec := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset=60", token, "")
	if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("usage: %d %s", rec.Code, rec.Body.String())
	}
	if len(usage.Keys) != 1 || usage.Keys[0].ID != mine.ID || usage.Keys[0].Kind != usageKindKey {
		t.Fatalf("keys %+v, want only %s", usage.Keys, mine.ID)
	}
	if usage.Totals.Requests != 2 || usage.Totals.Failed != 1 || usage.Totals != usage.Keys[0].Totals || usage.TZOffset != 60 {
		t.Fatalf("totals %+v, entry %+v", usage.Totals, usage.Keys[0].Totals)
	}

	idleRec := userCall(h, http.MethodGet, "/user/api/usage?range=7d", userSignIn(t, h, idle.Key), "")
	if err := json.Unmarshal(idleRec.Body.Bytes(), &usage); err != nil {
		t.Fatal(err)
	}
	if len(usage.Keys) != 1 || usage.Keys[0].ID != idle.ID || usage.Totals.Requests != 0 || len(usage.Keys[0].Series) != len(usage.Buckets) {
		t.Fatalf("idle key usage %+v", usage)
	}

	rec = userCall(h, http.MethodGet, "/user/api/usage/breakdown?range=24h", token, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accounts":[]`) || strings.Contains(rec.Body.String(), "acc-secret") {
		t.Fatalf("breakdown: %d %s", rec.Code, rec.Body.String())
	}
	var breakdown apiKeyUsageBreakdown
	if err := json.Unmarshal(rec.Body.Bytes(), &breakdown); err != nil {
		t.Fatal(err)
	}
	if breakdown.Ref != usageKindKey+":"+mine.ID || len(breakdown.Models) != 1 || breakdown.Models[0].ID != "model-a" || breakdown.Models[0].Requests != 2 {
		t.Fatalf("breakdown %+v", breakdown)
	}

	assertUserError(t, userCall(h, http.MethodGet, "/user/api/usage?range=1y", token, ""), http.StatusBadRequest, codeInvalidUsageRange)
	assertUserError(t, userCall(h, http.MethodGet, "/user/api/usage/breakdown?tzOffset=x", token, ""), http.StatusBadRequest, codeInvalidTZOffset)
}

func TestUserUsageIsCachedAndBudgeted(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "loop", "sk-user-usage-loop-0123456789", true)
	other := addUsageKey(t, "calm", "sk-user-usage-calm-0123456789", true)
	token := userSignIn(t, h, key.Key)

	first := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset=0", token, "")
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO requests (ts, account_id, api_key_id, model, success) VALUES (?, 'acc', ?, 'm', 1)`, time.Now().Unix()-60, key.ID); err != nil {
		t.Fatal(err)
	}
	if again := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset=0", token, ""); again.Body.String() != first.Body.String() {
		t.Fatalf("second call within the TTL was not the cached answer:\n%s\n%s", first.Body.String(), again.Body.String())
	}

	// Another time zone is another answer: a loop over them runs out of the key's budget.
	for tz := 1; tz < userUsageBuildsPerMinute; tz++ {
		if rec := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset="+strconv.Itoa(tz), token, ""); rec.Code != http.StatusOK {
			t.Fatalf("tz %d: %d %s", tz, rec.Code, rec.Body.String())
		}
	}
	busy := userCall(h, http.MethodGet, "/user/api/usage/breakdown?range=24h&tzOffset=-60", token, "")
	assertUserError(t, busy, http.StatusTooManyRequests, codeUserUsageBusy)
	if busy.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After %q", busy.Header().Get("Retry-After"))
	}
	// Cached answers still come back, and other keys keep their own budget.
	if rec := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset=0", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("cached answer while over budget: %d", rec.Code)
	}
	if rec := userCall(h, http.MethodGet, "/user/api/usage?range=24h&tzOffset=-60", userSignIn(t, h, other.Key), ""); rec.Code != http.StatusOK {
		t.Fatalf("other key: %d %s", rec.Code, rec.Body.String())
	}
}

func TestUserUsageCacheBuildsOnceForConcurrentCalls(t *testing.T) {
	var c userUsageCache
	var builds atomic.Int32
	release := make(chan struct{})
	var wg sync.WaitGroup
	bodies := make([]string, 5)
	for i := range bodies {
		wg.Go(func() {
			body, err := c.get("k", "usage|k|24h|0", func() (any, error) {
				builds.Add(1)
				<-release
				return map[string]int{"n": 1}, nil
			})
			if err != nil {
				t.Error(err)
			}
			bodies[i] = string(body)
		})
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := builds.Load(); n != 1 {
		t.Fatalf("%d builds for one answer, want 1", n)
	}
	for _, b := range bodies {
		if b != `{"n":1}` {
			t.Fatalf("bodies %q", bodies)
		}
	}

	// A build that panics releases its waiters; the next call builds again.
	func() {
		defer func() { _ = recover() }()
		_, _ = c.get("k", "panics", func() (any, error) { panic("boom") })
	}()
	if body, err := c.get("k", "panics", func() (any, error) { return 2, nil }); err != nil || string(body) != "2" {
		t.Fatalf("after a panic: %q %v", body, err)
	}
}

func TestUserAPIRouting(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-routing-0123456789abcdef", true)
	token := userSignIn(t, h, key.Key)
	for _, method := range []string{http.MethodOptions, http.MethodGet, http.MethodPost} {
		rec := userCall(h, method, "/user/api/key", token, "")
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("%s /user/api/key: Access-Control-Allow-Origin %q", method, got)
		}
	}
	if rec := userCall(h, http.MethodGet, "/user/api/nope", token, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown route: %d", rec.Code)
	}
	if isClientAPIPath("/user/api/requests") || requestEndpointForPath("/user/api/requests") != "" {
		t.Fatal("the user API counts as a client API path")
	}
	for _, target := range []string{"/user", "/user/login"} {
		assertIndexResponse(t, servePage(h, http.MethodGet, target), target)
	}
	assertUserError(t, userCall(h, http.MethodGet, "/user/api/key", "", ""), http.StatusUnauthorized, codeUserSessionExpired)
}

// userCallFrom is userCall from remote, through the public link when public is set.
func userCallFrom(h http.Handler, remote string, public bool, method, target, token, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	req.RemoteAddr = remote
	if public {
		req = req.WithContext(tunnel.WithTunnel(req.Context()))
	}
	if token != "" {
		req.Header.Set("X-User-Token", token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func assertUserNotFound(t *testing.T, rec *httptest.ResponseRecorder, target string) {
	t.Helper()
	if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("%s: %d %q %s, want a JSON 404", target, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	if got := userJSON(t, rec)["error"]; got != "Not Found" {
		t.Fatalf("%s: error %v", target, got)
	}
}

func userKeyID(t *testing.T, h http.Handler, token string) string {
	t.Helper()
	rec := userCall(h, http.MethodGet, "/user/api/key", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("key: %d %s", rec.Code, rec.Body.String())
	}
	id, _ := userJSON(t, rec)["id"].(string)
	return id
}

// Bodies the sign-in page never sends: each is a 400 or a 401 and never a session, and keys
// whose values share a prefix each sign in to their own key.
func TestUserSessionSignInBodies(t *testing.T) {
	h := newUserAPITestHandler(t)
	short := addUsageKey(t, "short", "sk-user-edge-0123456789", true)
	long := addUsageKey(t, "long", "sk-user-edge-0123456789-more", true)
	accented := addUsageKey(t, "unicode", "sk-ключ-日本語-0123456789", true)
	attempt := 0
	signIn := func(body string) *httptest.ResponseRecorder {
		attempt++
		return userCallFrom(h, "192.0.2."+strconv.Itoa(attempt)+":1000", false, http.MethodPost, "/user/api/session", "", body)
	}

	oversized := `{"key":"` + short.Key + `","pad":"` + strings.Repeat("a", 16<<10) + `"}`
	for _, body := range []string{"", "not json", `{"key":`, `{"key":123}`, `["` + short.Key + `"]`, `{"key":null}`, `{"key":" \t\n "}`, oversized} {
		assertUserError(t, signIn(body), http.StatusBadRequest, codeUserKeyRequired)
	}
	for _, value := range []string{"sk-user-edge-012345678", "k-user-edge-0123456789", "sk-user-edge-0123456789-mor", "SK-USER-EDGE-0123456789", "sk-user-edge-0123456789 x", "sk-ключ-日本語"} {
		assertUserError(t, signIn(`{"key":"`+value+`"}`), http.StatusUnauthorized, codeUserKeyInvalid)
	}
	for _, c := range []struct {
		body string
		want string
	}{
		{`{"key":"` + short.Key + `"}`, short.ID},
		{`{"key":"` + long.Key + `"}`, long.ID},
		{`{"key":"\n\t ` + long.Key + ` \r\n"}`, long.ID},
		{`{"key":"` + accented.Key + `"}`, accented.ID},
		{`{"key":"sk-ключ-日本語-0123456789"}`, accented.ID},
		{`{"other":1,"key":"` + short.Key + `"}`, short.ID},
	} {
		rec := signIn(c.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", c.body, rec.Code, rec.Body.String())
		}
		if got := userKeyID(t, h, userJSON(t, rec)["token"].(string)); got != c.want {
			t.Fatalf("%s signed in to %q, want %q", c.body, got, c.want)
		}
	}

	token := userSignIn(t, h, short.Key)
	assertUserError(t, userCall(h, http.MethodGet, "/user/api/session", "", ""), http.StatusUnauthorized, codeUserSessionExpired)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch} {
		assertUserNotFound(t, userCall(h, method, "/user/api/session", token, ""), method+" /session")
	}
	if rec := userCall(h, http.MethodDelete, "/user/api/session", token, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("sign out: %d", rec.Code)
	}
	assertUserError(t, userCall(h, http.MethodDelete, "/user/api/session", token, ""), http.StatusUnauthorized, codeUserSessionExpired)
}

func TestUserSessionsAreSeparate(t *testing.T) {
	h := newUserAPITestHandler(t)
	a := addUsageKey(t, "a", "sk-user-sep-a-0123456789", true)
	b := addUsageKey(t, "b", "sk-user-sep-b-0123456789", true)
	getObserveStore().RecordRequestWithAPIKey("acc", b.ID, b.Key, "", "model-b", 1, 1, 0, true, 200, "")

	first, second := userSignIn(t, h, a.Key), userSignIn(t, h, a.Key)
	if first == second || userKeyID(t, h, first) != a.ID || userKeyID(t, h, second) != a.ID {
		t.Fatal("two sign-ins of one key are not two working sessions")
	}
	if rec := userCall(h, http.MethodGet, "/user/api/requests", first, ""); strings.Contains(rec.Body.String(), "model-b") || userJSON(t, rec)["total"] != float64(0) {
		t.Fatalf("key a reads key b's requests: %s", rec.Body.String())
	}

	// The 17th sign-in of one key ends its oldest session only.
	tokens := []string{first, second}
	for len(tokens) < maxUserSessionsPerKey+1 {
		tokens = append(tokens, userSignIn(t, h, a.Key))
	}
	assertUserError(t, userCall(h, http.MethodGet, "/user/api/key", first, ""), http.StatusUnauthorized, codeUserSessionExpired)
	for _, token := range tokens[1:] {
		if got := userKeyID(t, h, token); got != a.ID {
			t.Fatalf("a newer session ended: %q", got)
		}
	}
	if got := userKeyID(t, h, userSignIn(t, h, b.Key)); got != b.ID {
		t.Fatalf("key b signed in to %q", got)
	}

	// The admin and user sessions are separate: neither token opens the other API.
	admin, _, err := h.adminSessions.Issue()
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"X-Admin-Token", "X-User-Token", "Authorization"} {
		req := httptest.NewRequest(http.MethodGet, "/user/api/key", nil)
		req.Header.Set(header, admin)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assertUserError(t, rec, http.StatusUnauthorized, codeUserSessionExpired)

		req = httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil)
		req.Header.Set(header, tokens[1])
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("user token in %s opened the admin API: %d", header, rec.Code)
		}
	}
	for _, header := range []string{"X-Admin-Password", "X-Api-Key", "Authorization"} {
		req := httptest.NewRequest(http.MethodGet, "/user/api/key", nil)
		req.Header.Set(header, a.Key)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assertUserError(t, rec, http.StatusUnauthorized, codeUserSessionExpired)
	}
}

// Many sign-ins of one key at once all succeed and leave at most the per-key cap of sessions.
func TestUserSessionConcurrentSignIns(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "busy", "sk-user-concurrent-0123456789", true)
	var wg sync.WaitGroup
	codes := make([]int, 40)
	for i := range codes {
		wg.Go(func() {
			codes[i] = userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"`+key.Key+`"}`).Code
		})
	}
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("sign-in %d: %d", i, code)
		}
	}
	h.userSessions.mu.Lock()
	n := len(h.userSessions.sessions)
	h.userSessions.mu.Unlock()
	if n != maxUserSessionsPerKey {
		t.Fatalf("%d sessions, want %d", n, maxUserSessionsPerKey)
	}
}

// A signed-in holder sees the admin's changes to the key on the next call.
func TestUserSessionFollowsKeyEdits(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "before", "sk-user-edits-0123456789", true)
	token := userSignIn(t, h, key.Key)
	view := func() map[string]any {
		t.Helper()
		rec := userCall(h, http.MethodGet, "/user/api/key", token, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("key: %d %s", rec.Code, rec.Body.String())
		}
		return userJSON(t, rec)
	}

	if err := config.UpdateApiKey(key.ID, config.ApiKeyEntry{Name: "after", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if v := view(); v["name"] != "after" || v["enabled"] != true || v["expired"] != false {
		t.Fatalf("renamed %v", v)
	}
	if err := config.UpdateApiKey(key.ID, config.ApiKeyEntry{Name: "after", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if v := view(); v["enabled"] != false {
		t.Fatalf("disabled %v", v)
	}
	past := time.Now().Add(-time.Minute).Unix()
	if err := config.UpdateApiKey(key.ID, config.ApiKeyEntry{Name: "after", Enabled: true, ExpiresAt: past}); err != nil {
		t.Fatal(err)
	}
	if v := view(); v["expired"] != true || v["expiresAt"] != float64(past) || v["enabled"] != true {
		t.Fatalf("expired %v", v)
	}
	for _, target := range []string{"/user/api/usage?range=7d", "/user/api/usage/breakdown?range=7d", "/user/api/requests"} {
		if rec := userCall(h, http.MethodGet, target, token, ""); rec.Code != http.StatusOK {
			t.Fatalf("%s for an expired key: %d", target, rec.Code)
		}
	}
}

func TestUserKeyShowsRequireAPIKey(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-required-0123456789", true)
	token := userSignIn(t, h, key.Key)
	for _, on := range []bool{true, false, true} {
		if err := config.UpdateSettingsPatch(&on, ""); err != nil {
			t.Fatal(err)
		}
		if got := userJSON(t, userCall(h, http.MethodGet, "/user/api/key", token, ""))["keysRequired"]; got != on {
			t.Fatalf("keysRequired %v, want %v", got, on)
		}
	}
}

func TestUserRequestsPagingEdges(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-paging-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-paging-other-0123456789", true)
	gone := addUsageKey(t, "gone", "sk-user-paging-gone-0123456789", true)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	insert := func(keyID, key, requestID string, success int) {
		t.Helper()
		if _, err := d.Exec(`INSERT INTO requests (ts, account_id, api_key_id, api_key, model, success, status, request_id) VALUES (1700000000, 'acc', ?, ?, 'm', ?, 200, ?)`,
			keyID, key, success, requestID); err != nil {
			t.Fatal(err)
		}
	}
	// 30 rows of one second, oldest first; every third one failed.
	for i := 0; i < 30; i++ {
		insert(mine.ID, "", fmt.Sprintf("mine-%02d", i), boolInt(i%3 != 0))
	}
	insert(other.ID, "", "other", 1)
	insert(gone.ID, "", "gone", 1)
	insert("", "", "legacy-none", 1)
	insert("", mine.Key, "legacy-raw", 0)
	if err := config.DeleteApiKey(gone.ID); err != nil {
		t.Fatal(err)
	}
	reused := addUsageKey(t, "reused", gone.Key, true)
	token := userSignIn(t, h, mine.Key)

	type page struct {
		Requests []struct {
			RequestID string `json:"requestId"`
			Success   bool   `json:"success"`
		} `json:"requests"`
		Total    int `json:"total"`
		Page     int `json:"page"`
		PageSize int `json:"pageSize"`
	}
	get := func(token, query string) page {
		t.Helper()
		rec := userCall(h, http.MethodGet, "/user/api/requests"+query, token, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
		var p page
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ids := func(p page) string {
		out := make([]string, len(p.Requests))
		for i, r := range p.Requests {
			out[i] = r.RequestID
		}
		return strings.Join(out, ",")
	}

	// Newest first, and rows of one second keep one order, so pages neither repeat nor skip.
	var seen []string
	for n := 1; n <= 3; n++ {
		p := get(token, "?pageSize=10&page="+strconv.Itoa(n))
		if p.Total != 30 || p.Page != n || p.PageSize != 10 || len(p.Requests) != 10 {
			t.Fatalf("page %d: %+v", n, p)
		}
		seen = append(seen, ids(p))
	}
	var want []string
	for i := 29; i >= 0; i-- {
		want = append(want, fmt.Sprintf("mine-%02d", i))
	}
	if got := strings.Join(seen, ","); got != strings.Join(want, ",") {
		t.Fatalf("order %s", got)
	}

	for _, c := range []struct {
		query         string
		page, size, n int
		first         string
	}{
		{"?page=0", 1, 25, 25, "mine-29"},
		{"?page=-3", 1, 25, 25, "mine-29"},
		{"?page=abc", 1, 25, 25, "mine-29"},
		{"?page=2", 2, 25, 5, "mine-04"},
		{"?pageSize=0", 1, 25, 25, "mine-29"},
		{"?pageSize=-5", 1, 25, 25, "mine-29"},
		{"?pageSize=x", 1, 25, 25, "mine-29"},
		{"?pageSize=2.5", 1, 25, 25, "mine-29"},
		{"?pageSize=1000", 1, maxUserRequestsPageSize, 30, "mine-29"},
		{"?pageSize=1", 1, 1, 1, "mine-29"},
		{"?page=4&pageSize=10", 4, 10, 0, ""},
		{"?page=31&pageSize=1", 31, 1, 0, ""},
	} {
		p := get(token, c.query)
		first := ""
		if len(p.Requests) > 0 {
			first = p.Requests[0].RequestID
		}
		if p.Total != 30 || p.Page != c.page || p.PageSize != c.size || len(p.Requests) != c.n || first != c.first {
			t.Fatalf("%s: total %d page %d size %d rows %d first %q", c.query, p.Total, p.Page, p.PageSize, len(p.Requests), first)
		}
	}
	// A page number so large its offset overflows is past the end, not the first page again.
	for _, query := range []string{
		"?page=9223372036854775807", "?page=9223372036854775807&pageSize=100", "?page=4611686018427387905&pageSize=4",
		"?page=99999999999999999999", "?page=2147483648&pageSize=100",
	} {
		if p := get(token, query); p.Total != 30 || len(p.Requests) != 0 || p.Page < 2 {
			t.Fatalf("%s: total %d page %d rows %s", query, p.Total, p.Page, ids(p))
		}
	}

	for status, want := range map[string]int{"success": 20, "error": 10, "all": 30, "": 30, "bogus": 30, "SUCCESS": 30} {
		p := get(token, "?pageSize=100&status="+status)
		if p.Total != want || len(p.Requests) != want {
			t.Fatalf("status=%s: total %d", status, p.Total)
		}
		for _, r := range p.Requests {
			if (status == "success" && !r.Success) || (status == "error" && r.Success) {
				t.Fatalf("status=%s holds %+v", status, r)
			}
		}
	}

	// Another key, a deleted key, rows without a key ID and a new key with a deleted key's
	// value each stay out.
	if p := get(token, "?pageSize=100"); strings.Contains(ids(p), "other") || strings.Contains(ids(p), "gone") || strings.Contains(ids(p), "legacy") {
		t.Fatalf("foreign rows %s", ids(p))
	}
	if p := get(userSignIn(t, h, reused.Key), ""); p.Total != 0 {
		t.Fatalf("a new key with a deleted key's value reads its rows: %s", ids(p))
	}
}

// The status tabs' counts are this key's alone on every tab and page, and the admin sorts a
// holder may use order the key's rows as on the Requests page; account sorts fall back to time.
func TestUserRequestsCountsAndSort(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-sort-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-sort-other-0123456789", true)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		id, keyID, email, model string
		ts                      int64
		tokens, durationMs      int
		credits                 float64
		success                 bool
	}
	rows := []row{
		{"a", mine.ID, "zed@example.com", "model-b", 1700000003, 300, 900, 0.30, true},
		{"b", mine.ID, "amy@example.com", "model-c", 1700000001, 100, 2500, 0.10, false},
		{"c", mine.ID, "kim@example.com", "model-a", 1700000004, 200, 100, 0.20, true},
		{"d", mine.ID, "bob@example.com", "model-d", 1700000002, 400, 1500, 0.40, true},
		{"x", other.ID, "aaa@example.com", "model-0", 1700000005, 999, 9999, 9.99, false},
		{"y", other.ID, "aaa@example.com", "model-0", 1700000006, 999, 9999, 9.99, true},
		{"legacy", "", "aaa@example.com", "model-0", 1700000007, 999, 9999, 9.99, false},
	}
	for _, r := range rows {
		if _, err := d.Exec(`INSERT INTO requests (ts, account_id, api_key_id, email, model, total_tokens, credits, duration_ms, success, status, request_id) VALUES (?, 'acc', ?, ?, ?, ?, ?, ?, ?, 200, ?)`,
			r.ts, r.keyID, r.email, r.model, r.tokens, r.credits, r.durationMs, boolInt(r.success), r.id); err != nil {
			t.Fatal(err)
		}
	}
	token := userSignIn(t, h, mine.Key)

	type page struct {
		Requests []struct {
			RequestID string `json:"requestId"`
		} `json:"requests"`
		Total  int               `json:"total"`
		Sort   string            `json:"sort"`
		Order  string            `json:"order"`
		Counts userRequestCounts `json:"counts"`
	}
	get := func(query string) page {
		t.Helper()
		rec := userCall(h, http.MethodGet, "/user/api/requests"+query, token, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
		var p page
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ids := func(p page) string {
		out := make([]string, len(p.Requests))
		for i, r := range p.Requests {
			out[i] = r.RequestID
		}
		return strings.Join(out, ",")
	}

	want := userRequestCounts{All: 4, Succeeded: 3, Failed: 1}
	for _, query := range []string{"", "?status=success", "?status=error", "?status=bogus", "?page=9&pageSize=1", "?sort=tokens&order=asc", "?status=error&page=3"} {
		if p := get(query); p.Counts != want {
			t.Fatalf("%q counts %+v, want %+v", query, p.Counts, want)
		}
	}

	for _, c := range []struct {
		query, sort, order, ids string
	}{
		{"", "time", "desc", "c,a,d,b"},
		{"?order=asc", "time", "asc", "b,d,a,c"},
		{"?sort=tokens", "tokens", "desc", "d,a,c,b"},
		{"?sort=tokens&order=asc", "tokens", "asc", "b,c,a,d"},
		{"?sort=credits&order=asc", "credits", "asc", "b,c,a,d"},
		{"?sort=duration", "duration", "desc", "b,d,a,c"},
		{"?sort=model&order=asc", "model", "asc", "c,a,b,d"},
		{"?sort=status&order=asc", "status", "asc", "b,a,c,d"},
		{"?sort=STATUS&order=ASC", "status", "asc", "b,a,c,d"},
		{"?sort=tokens&order=sideways", "tokens", "desc", "d,a,c,b"},
		{"?sort=tokens&status=success&order=asc", "tokens", "asc", "c,a,d"},
		// Ordered by account, the rows would show how the accounts' emails sort.
		{"?sort=account&order=asc", "time", "asc", "b,d,a,c"},
		{"?sort=api_key", "time", "desc", "c,a,d,b"},
		{"?sort=bogus", "time", "desc", "c,a,d,b"},
	} {
		p := get(c.query)
		if p.Sort != c.sort || p.Order != c.order || ids(p) != c.ids || p.Total != len(p.Requests) {
			t.Fatalf("%s: sort %s order %s rows %s, want %s %s %s", c.query, p.Sort, p.Order, ids(p), c.sort, c.order, c.ids)
		}
	}
	// Paging follows the sort: the second page of two holds the rest.
	if p := get("?sort=tokens&pageSize=2&page=2"); ids(p) != "c,b" || p.Total != 4 {
		t.Fatalf("sorted page 2: %s", ids(p))
	}

	// The other key sees only its own rows and counts, whatever it sorts by.
	otherToken := userSignIn(t, h, other.Key)
	rec := userCall(h, http.MethodGet, "/user/api/requests?sort=tokens&order=asc", otherToken, "")
	var p page
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if ids(p) != "x,y" || p.Counts != (userRequestCounts{All: 2, Succeeded: 1, Failed: 1}) {
		t.Fatalf("other key: rows %s counts %+v", ids(p), p.Counts)
	}
	for _, leak := range []string{"@example.com", `"a"`, "model-a", "legacy"} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Fatalf("other key's page leaks %q: %s", leak, rec.Body.String())
		}
	}
}

// The in-memory log, used when the database cannot be read, keeps the same order: newest first,
// rows of one second in the order they were logged.
func TestUserRequestsMemoryPageOrder(t *testing.T) {
	newUserAPITestHandler(t)
	key := addUsageKey(t, "mine", "sk-user-memory-0123456789", true)
	pinObserveClock(t, time.Unix(1700000000, 0))
	s := getObserveStore()
	for i := 0; i < 40; i++ {
		s.RecordRequestWithAPIKey("acc", key.ID, key.Key, "", fmt.Sprintf("m%02d", i), 1, 1, 0, true, 200, "")
	}
	var got []string
	for n := 1; n <= 4; n++ {
		p := s.memoryRequestPage(normalizeRequestQuery(requestQuery{Page: n, PageSize: 10, APIKeyID: key.ID}))
		for _, rec := range p.Requests {
			got = append(got, rec.Model)
		}
	}
	var want []string
	for i := 39; i >= 0; i-- {
		want = append(want, fmt.Sprintf("m%02d", i))
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("memory order %v", got)
	}
	huge := s.memoryRequestPage(normalizeRequestQuery(requestQuery{Page: math.MaxInt, PageSize: 10, APIKeyID: key.ID}))
	if huge.Total != 40 || len(huge.Requests) != 0 {
		t.Fatalf("huge page: total %d rows %d", huge.Total, len(huge.Requests))
	}
}

// Every range and time zone answers with this key's entry only: its request log rows, its
// pruned daily rows and, for all time, its pruned rows without a day as earlier traffic.
func TestUserUsageEveryWindow(t *testing.T) {
	h := newUserAPITestHandler(t)
	mine := addUsageKey(t, "mine", "sk-user-window-mine-0123456789", true)
	other := addUsageKey(t, "other", "sk-user-window-other-0123456789", true)
	now := time.Now()
	insertUsageRows(t,
		usageRow{ts: now.Unix() - 600, keyID: mine.ID, success: true, in: 10, out: 5, credits: 0.5, repeated: 2},
		usageRow{ts: now.Unix() - 600, keyID: other.ID, success: true, repeated: 3},
		usageRow{ts: now.Unix() - 600, success: true},
	)
	day := now.Unix()/daySeconds - 3
	insertDailyRollup(t, day, mine.ID, "model-pruned", "acc-secret", 4)
	insertDailyRollup(t, day, other.ID, "model-other", "acc-secret", 7)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	// Pruned before daily totals were kept: 5 more of mine and 9 more of the other key's.
	if _, err := d.Exec(`INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count) VALUES ('model-old', 'acc-secret', ?, 1, 5), ('model-old', 'acc-secret', ?, 1, 9)`, mine.ID, other.ID); err != nil {
		t.Fatal(err)
	}
	token := userSignIn(t, h, mine.Key)
	wantRequests := map[string]int64{"24h": 2, "7d": 6, "30d": 6, "all": 11}
	wantModels := map[string]string{"24h": "=2", "7d": "model-pruned=4,=2", "30d": "model-pruned=4,=2", "all": "model-old=5,model-pruned=4,=2"}

	for _, rng := range []string{"24h", "7d", "30d", "all"} {
		for _, tz := range []string{"-840", "0", "330", "840", ""} {
			h.userUsage.mu.Lock()
			clear(h.userUsage.budgets)
			h.userUsage.mu.Unlock()
			query := "?range=" + rng + "&tzOffset=" + tz
			rec := userCall(h, http.MethodGet, "/user/api/usage"+query, token, "")
			var usage apiKeyUsageResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil || rec.Code != http.StatusOK {
				t.Fatalf("usage%s: %d %s", query, rec.Code, rec.Body.String())
			}
			wantTZ, _ := strconv.Atoi(tz)
			if usage.Range != rng || usage.TZOffset != wantTZ || len(usage.Keys) != 1 || usage.Keys[0].ID != mine.ID || usage.Totals != usage.Keys[0].Totals {
				t.Fatalf("usage%s: %+v", query, usage)
			}
			if usage.Totals.Requests != wantRequests[rng] || len(usage.Keys[0].Series) != len(usage.Buckets) {
				t.Fatalf("usage%s: totals %+v, %d series for %d buckets", query, usage.Totals, len(usage.Keys[0].Series), len(usage.Buckets))
			}
			if rng == "all" {
				if usage.Earlier == nil || usage.Earlier.Requests != 5 || usage.Keys[0].Earlier == nil || *usage.Earlier != *usage.Keys[0].Earlier {
					t.Fatalf("usage%s: earlier %+v", query, usage.Earlier)
				}
			} else if usage.Earlier != nil {
				t.Fatalf("usage%s: earlier %+v outside all time", query, usage.Earlier)
			}

			rec = userCall(h, http.MethodGet, "/user/api/usage/breakdown"+query, token, "")
			var breakdown apiKeyUsageBreakdown
			if err := json.Unmarshal(rec.Body.Bytes(), &breakdown); err != nil || rec.Code != http.StatusOK {
				t.Fatalf("breakdown%s: %d %s", query, rec.Code, rec.Body.String())
			}
			var models []string
			for _, m := range breakdown.Models {
				models = append(models, m.ID+"="+strconv.FormatInt(m.Requests, 10))
			}
			if strings.Join(models, ",") != wantModels[rng] || breakdown.Accounts == nil || len(breakdown.Accounts) != 0 || strings.Contains(rec.Body.String(), "acc-secret") {
				t.Fatalf("breakdown%s: %s", query, rec.Body.String())
			}
		}
	}

	for _, tz := range []string{"841", "-841", "1.5", "abc", "0x10", " 60", "9999999999999999999"} {
		for _, route := range []string{"/user/api/usage", "/user/api/usage/breakdown"} {
			assertUserError(t, userCall(h, http.MethodGet, route+"?tzOffset="+url.QueryEscape(tz), token, ""), http.StatusBadRequest, codeInvalidTZOffset)
		}
	}
	for _, rng := range []string{"1y", "ALL", "24H", "90d"} {
		assertUserError(t, userCall(h, http.MethodGet, "/user/api/usage?range="+rng, token, ""), http.StatusBadRequest, codeInvalidUsageRange)
	}
}

// A row at the first second of a range counts and a row at its end does not.
func TestUserUsageRangeEdges(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "mine", "sk-user-edges-0123456789", true)
	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	pinObserveClock(t, now)
	token := userSignIn(t, h, key.Key)
	for _, c := range []struct {
		rng string
		tz  int
	}{{"24h", 330}, {"7d", -840}, {"30d", 840}} {
		h.userUsage = userUsageCache{}
		rng, _ := parseUsageRange(c.rng)
		off := int64(c.tz) * 60
		cur := (now.Unix() + off) / rng.bucketSec
		from := (cur-int64(rng.buckets)+1)*rng.bucketSec - off
		to := (cur+1)*rng.bucketSec - off
		d, err := db.Get()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.Exec(`DELETE FROM requests`); err != nil {
			t.Fatal(err)
		}
		insertUsageRows(t,
			usageRow{ts: from - 1, keyID: key.ID, success: true},
			usageRow{ts: from, keyID: key.ID, success: true},
			usageRow{ts: to - 1, keyID: key.ID, success: false},
			usageRow{ts: to, keyID: key.ID, success: true},
		)
		var usage apiKeyUsageResponse
		rec := userCall(h, http.MethodGet, "/user/api/usage?range="+c.rng+"&tzOffset="+strconv.Itoa(c.tz), token, "")
		if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil {
			t.Fatal(err)
		}
		series := usage.Keys[0].Series
		if usage.From != from || usage.To != to || usage.Totals.Requests != 2 || series[0].Requests != 1 || series[len(series)-1].Failed != 1 {
			t.Fatalf("%s tz %d: from %d to %d totals %+v", c.rng, c.tz, usage.From, usage.To, usage.Totals)
		}
	}
}

func TestUserAPIPathEdges(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-paths-0123456789", true)
	token := userSignIn(t, h, key.Key)
	for _, target := range []string{
		"/user/api", "/user/api/", "/user/api/key/", "/user/api//key", "/user/api/KEY", "/user/api/key/extra",
		"/user/api/../admin/api/settings", "/user/api/%2e%2e/admin/api/settings", "/user/api/%2E%2E/%2E%2E/admin/api/settings",
		"/user/api/key%2f", "/user/api/usage/", "/user/api/requests/1",
	} {
		assertUserNotFound(t, userCall(h, http.MethodGet, target, token, ""), target)
		rec := userCall(h, http.MethodGet, target, "", "")
		assertUserError(t, rec, http.StatusUnauthorized, codeUserSessionExpired)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("%s: Access-Control-Allow-Origin %q", target, got)
		}
	}
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		if rec := userCall(h, method, "/user/api/key", token, ""); rec.Code != http.StatusNotFound {
			t.Fatalf("%s /user/api/key: %d", method, rec.Code)
		}
	}
	for _, target := range []string{"/user/api/session", "/user/api/key", "/user/api"} {
		rec := userCall(h, http.MethodOptions, target, "", "")
		if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "" || rec.Header().Get("Access-Control-Allow-Headers") != "" {
			t.Fatalf("OPTIONS %s: %d %v", target, rec.Code, rec.Header())
		}
	}
	for _, target := range []string{"/user", "/user/", "/user/login", "/user/unknown", "/user/login?next=%2Fuser"} {
		assertIndexResponse(t, servePage(h, http.MethodGet, target), target)
	}
}

// Through the public link the sign-in lockout counts each visitor's address, not the helper's.
func TestUserSessionThroughPublicLink(t *testing.T) {
	h := newUserAPITestHandler(t)
	key := addUsageKey(t, "team", "sk-user-public-0123456789", true)
	signIn := func(remote string, public bool, value string) *httptest.ResponseRecorder {
		return userCallFrom(h, remote, public, http.MethodPost, "/user/api/session", "", `{"key":"`+value+`"}`)
	}
	rec := signIn("203.0.113.7:51000", true, key.Key)
	if rec.Code != http.StatusOK {
		t.Fatalf("public sign-in: %d %s", rec.Code, rec.Body.String())
	}
	token := userJSON(t, rec)["token"].(string)
	if rec := userCallFrom(h, "203.0.113.7:51001", true, http.MethodGet, "/user/api/key", token, ""); rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("public key view: %d %v", rec.Code, rec.Header())
	}

	for i := 0; i < adminGuessesPerClient; i++ {
		assertUserError(t, signIn("203.0.113.7:"+strconv.Itoa(52000+i), true, "sk-wrong"), http.StatusUnauthorized, codeUserKeyInvalid)
	}
	if rec := signIn("203.0.113.7:53000", true, key.Key); rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("locked-out visitor: %d %v", rec.Code, rec.Header())
	}
	for _, other := range []struct {
		remote string
		public bool
	}{{"203.0.113.8:51000", true}, {"127.0.0.1:40000", false}, {"0.0.0.0:0", true}} {
		if rec := signIn(other.remote, other.public, key.Key); rec.Code != http.StatusOK {
			t.Fatalf("%s: %d, another visitor shares the lockout", other.remote, rec.Code)
		}
	}
	// The session itself is not tied to an address.
	if rec := userCallFrom(h, "198.51.100.1:1", false, http.MethodGet, "/user/api/key", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("session from another address: %d", rec.Code)
	}
}

func TestUserSessionsSurviveARestartIntoAnUpdate(t *testing.T) {
	h := newUserAPITestHandler(t)
	entry := addUsageKey(t, "carried", "sk-user-handoff-0123456789", true)
	token := userSignIn(t, h, entry.Key)

	data := h.ExportUserSessions()
	if data == nil {
		t.Fatal("no sessions exported")
	}
	if strings.Contains(string(data), entry.Key) {
		t.Fatal("the handoff carries the key's value")
	}

	// The process the update restarts into: the same data folder, a new handler.
	next := newHandlerWithoutBackgroundForTest(t)
	if n := next.ImportUserSessions(data); n != 1 {
		t.Fatalf("imported %d sessions, want 1", n)
	}
	if rec := userCall(next, http.MethodGet, "/user/api/key", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("carried session: %d %s", rec.Code, rec.Body.String())
	}

	// Expired, malformed and unknown-shape entries are dropped; a key's cap still holds.
	hash := strings.Repeat("ab", sha256.Size)
	future := time.Now().Add(time.Hour)
	list := []userSessionHandoff{
		{Token: "expired", KeyID: entry.ID, KeyHash: hash, Expires: time.Now().Add(-time.Minute)},
		{Token: "badhash", KeyID: entry.ID, KeyHash: "zz", Expires: future},
		{Token: "nokey", KeyHash: hash, Expires: future},
		{Token: strings.Repeat("x", maxHandoffTokenLen+1), KeyID: entry.ID, KeyHash: hash, Expires: future},
	}
	for i := range maxUserSessionsPerKey + 3 {
		list = append(list, userSessionHandoff{Token: "t" + strconv.Itoa(i), KeyID: "k", KeyHash: hash, Expires: future})
	}
	raw, err := json.Marshal(list)
	if err != nil {
		t.Fatal(err)
	}
	var fresh userSessionStore
	if n := fresh.Import(raw); n != maxUserSessionsPerKey {
		t.Fatalf("imported %d, want the per-key cap %d", n, maxUserSessionsPerKey)
	}
	if n := fresh.Import([]byte("not json")); n != 0 {
		t.Fatalf("imported %d from garbage", n)
	}
	// None outlives the TTL it was issued with.
	far := []userSessionHandoff{{Token: "far", KeyID: "k2", KeyHash: hash, Expires: time.Now().Add(30 * 24 * time.Hour)}}
	raw, _ = json.Marshal(far)
	fresh.Import(raw)
	if got := fresh.sessions["far"].expiry; got.After(time.Now().Add(userSessionTTL + time.Second)) {
		t.Fatalf("imported expiry %v outlives the TTL", got)
	}
}

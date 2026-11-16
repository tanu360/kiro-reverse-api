package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
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
	assertKeySet(t, "page", body, "requests", "total", "page", "pageSize")
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

package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

// pinActivityZone makes "today" a calendar day in loc for the rest of the test.
func pinActivityZone(t *testing.T, loc *time.Location) {
	t.Helper()
	old := activityLocation
	activityLocation = func() *time.Location { return loc }
	t.Cleanup(func() { activityLocation = old })
}

// newActivityStoreForTest is a fresh observe store with an empty live RPM tracker.
func newActivityStoreForTest(t *testing.T) *observeStore {
	t.Helper()
	s := newObserveStoreForTest(t)
	accountRates.reset()
	t.Cleanup(accountRates.reset)
	return s
}

func recordFinal(s *observeStore, accountID string, success bool) {
	status := http.StatusOK
	if !success {
		status = http.StatusInternalServerError
	}
	s.RecordTracedRequestWithCache(nil, accountID, "", "", accountID+"@example.com", "claude-sonnet-4.5", 10, 5, 0.1, success, status, "", cacheTokenCounts{})
}

func activityAt(s *observeStore, now time.Time) map[string]int {
	_, curMin := curSlot(now.Unix())
	return s.accountToday(floorDiv(localDayStart(now).Unix(), 60), curMin)
}

func TestAccountActivity_TodayRollsOverAtLocalMidnight(t *testing.T) {
	zone := time.FixedZone("IST", 5*3600+30*60)
	pinActivityZone(t, zone)
	s := newActivityStoreForTest(t)

	pinObserveClock(t, time.Date(2026, 11, 11, 23, 59, 10, 0, zone))
	recordFinal(s, "a", true)
	recordFinal(s, "a", false)
	pinObserveClock(t, time.Date(2026, 11, 12, 0, 1, 0, 0, zone))
	recordFinal(s, "a", true)
	recordFinal(s, "b", true)

	now := time.Date(2026, 11, 12, 0, 1, 30, 0, zone)
	got := activityAt(s, now)
	if got["a"] != 1 || got["b"] != 1 {
		t.Fatalf("today just after local midnight = %v, want a:1 b:1 (yesterday's two left out)", got)
	}
	got = activityAt(s, time.Date(2026, 11, 11, 23, 59, 50, 0, zone))
	if got["a"] != 2 || got["b"] != 0 {
		t.Fatalf("today just before local midnight = %v, want a:2", got)
	}
	got = activityAt(s, time.Date(2026, 11, 13, 0, 0, 5, 0, zone))
	if len(got) != 0 {
		t.Fatalf("today after the next midnight = %v, want nothing", got)
	}
}

func TestAccountActivity_RetriedRequestCountsOnceOnFinalAccount(t *testing.T) {
	s := newActivityStoreForTest(t)
	now := time.Now()
	pinObserveClock(t, now)

	// One client request: two failed attempts on a, then failover to b, which answers.
	s.RecordFailure("a", "claude-sonnet-4.5")
	s.RecordFailure("a", "claude-sonnet-4.5")
	recordFinal(s, "b", true)

	today := activityAt(s, now)
	if today["a"] != 0 || today["b"] != 1 {
		t.Fatalf("today = %v, want a:0 b:1", today)
	}
	if a, b := accountRates.count("a", now.Unix()), accountRates.count("b", now.Unix()); a != 0 || b != 1 {
		t.Fatalf("live rpm = a:%d b:%d, want a:0 b:1", a, b)
	}
}

func TestAccountActivity_CountsSuccessAndFailure(t *testing.T) {
	s := newActivityStoreForTest(t)
	now := time.Now()
	pinObserveClock(t, now)

	recordFinal(s, "a", true)
	recordFinal(s, "a", false)
	recordFinal(s, "a", true)
	// Rejected before any account was picked: no account's number moves.
	recordFinal(s, "", false)

	if got := activityAt(s, now)["a"]; got != 3 {
		t.Fatalf("today = %d, want 3 (two successes, one failure)", got)
	}
	if got := accountRates.count("a", now.Unix()); got != 3 {
		t.Fatalf("live rpm = %d, want 3", got)
	}
	if got := accountRates.snapshot(now.Unix()); len(got) != 1 {
		t.Fatalf("snapshot = %v, want only a", got)
	}
}

func TestAccountActivity_LiveRPMSlidingWindow(t *testing.T) {
	newActivityStoreForTest(t)
	base := int64(1_800_000_000)
	accountRates.record("a", base)
	accountRates.record("a", base+30)
	accountRates.record("a", base+61)

	cases := []struct {
		at   int64
		want int
	}{
		{base, 1},
		{base + 30, 2},
		{base + 59, 2},
		{base + 60, 1},  // the first left the last 60 s
		{base + 61, 2},  // 30 and 61
		{base + 90, 1},  // only 61
		{base + 120, 1}, // 61 is still inside (60, 120]
		{base + 125, 0},
	}
	for _, tc := range cases {
		if got := accountRates.count("a", tc.at); got != tc.want {
			t.Fatalf("rpm at +%ds = %d, want %d", tc.at-base, got, tc.want)
		}
	}
	if got := accountRates.count("a", base+20); got != 1 {
		t.Fatalf("rpm with the clock stepped back = %d, want 1 (only the slot from before now)", got)
	}
	if snap := accountRates.snapshot(base + 125); len(snap) != 0 {
		t.Fatalf("snapshot of an idle minute = %v, want empty", snap)
	}
	if accountRates.rings["a"] != nil {
		t.Fatal("an idle ring was kept after the snapshot")
	}
}

func TestAccountActivity_TodaySurvivesRestart(t *testing.T) {
	s := newActivityStoreForTest(t)
	now := time.Now()
	pinObserveClock(t, now)
	recordFinal(s, "a", true)
	recordFinal(s, "a", false)
	s.RecordFailure("a", "claude-sonnet-4.5")

	if err := s.LoadFromDB(); err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	if got := activityAt(s, now)["a"]; got != 2 {
		t.Fatalf("today after a rebuild from SQLite = %d, want 2", got)
	}
}

func TestAccountActivity_ResetClears(t *testing.T) {
	s := newActivityStoreForTest(t)
	now := time.Now()
	pinObserveClock(t, now)
	recordFinal(s, "a", true)
	s.Reset()
	if got := activityAt(s, now)["a"]; got != 0 {
		t.Fatalf("today after a stats reset = %d, want 0", got)
	}
	if got := accountRates.count("a", now.Unix()); got != 0 {
		t.Fatalf("live rpm after a stats reset = %d, want 0", got)
	}
}

// clearRPMStarts drops the shared pool's recorded starts: the pool forgets them
// whenever it is asked while the limit is off.
func clearRPMStarts(p *accountpool.AccountPool) {
	_ = config.UpdateAccountRPMLimit(0)
	p.AtRPMLimit()
}

func TestAPIAccountActivity_Shape(t *testing.T) {
	newActivityStoreForTest(t)
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	config.SetPassword("admin-password")
	for _, id := range []string{"act-a", "act-b"} {
		if err := config.AddAccount(config.Account{ID: id, Enabled: true, AccessToken: "token-" + id}); err != nil {
			t.Fatalf("add account: %v", err)
		}
	}
	h := newHandlerWithoutBackgroundForTest(t)
	h.pool.Reload()
	clearRPMStarts(h.pool)
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatalf("set limit: %v", err)
	}
	t.Cleanup(func() { clearRPMStarts(h.pool) })

	if acc := h.pool.GetPreferredForModelExcluding("act-a", "", nil); acc == nil || acc.ID != "act-a" {
		t.Fatalf("pick = %v, want act-a", acc)
	}
	recordFinal(getObserveStore(), "act-a", true)
	recordFinal(getObserveStore(), "gone", true)

	req := httptest.NewRequest(http.MethodGet, "/admin/api/observe/account-activity", nil)
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		NowUnix      int64 `json:"nowUnix"`
		DayStartUnix int64 `json:"dayStartUnix"`
		RPMLimit     int   `json:"rpmLimit"`
		Accounts     map[string]struct {
			Today   *int  `json:"today"`
			RPM     *int  `json:"rpm"`
			AtLimit *bool `json:"atLimit"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if body.RPMLimit != 1 || body.NowUnix == 0 || body.DayStartUnix > body.NowUnix || body.NowUnix-body.DayStartUnix > 25*3600 {
		t.Fatalf("header fields = %+v", body)
	}
	if len(body.Accounts) != 2 {
		t.Fatalf("accounts = %v, want the two configured ones (no deleted id)", body.Accounts)
	}
	a, b := body.Accounts["act-a"], body.Accounts["act-b"]
	if a.Today == nil || *a.Today != 1 || *a.RPM != 1 || !*a.AtLimit {
		t.Fatalf("act-a = %s", rec.Body.String())
	}
	if b.Today == nil || *b.Today != 0 || *b.RPM != 0 || *b.AtLimit {
		t.Fatalf("act-b = %s", rec.Body.String())
	}

	unauth := httptest.NewRecorder()
	h.ServeHTTP(unauth, httptest.NewRequest(http.MethodGet, "/admin/api/observe/account-activity", nil))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("without admin auth: status %d, want 401", unauth.Code)
	}
}

func TestSettingsAccountRPMLimitRangeAndLive(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "lim-a", Enabled: true, AccessToken: "token"}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	clearRPMStarts(p)
	t.Cleanup(func() { clearRPMStarts(p) })
	h := &Handler{pool: p}

	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(body)))
		return rec
	}
	for _, bad := range []string{`{"accountRpmLimit":-1,"sessionAffinity":false}`, `{"accountRpmLimit":1001}`} {
		rec := post(bad)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), codeAccountRPMLimitRange) {
			t.Fatalf("%s: status %d body %s, want 400 %s", bad, rec.Code, rec.Body.String(), codeAccountRPMLimitRange)
		}
	}
	if config.GetAccountRPMLimit() != 0 || !config.GetSessionAffinity() {
		t.Fatal("a rejected patch still saved a field")
	}

	if rec := post(`{"accountRpmLimit":30}`); rec.Code != http.StatusOK {
		t.Fatalf("set 30: status %d body %s", rec.Code, rec.Body.String())
	}
	get := httptest.NewRecorder()
	h.apiGetSettings(get, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
	var settings map[string]interface{}
	_ = json.Unmarshal(get.Body.Bytes(), &settings)
	if settings["accountRpmLimit"] != float64(30) {
		t.Fatalf("GET settings accountRpmLimit = %v, want 30", settings["accountRpmLimit"])
	}

	// Lowering to 1 takes effect on the next pick, with no pool Reload.
	if rec := post(`{"accountRpmLimit":1}`); rec.Code != http.StatusOK {
		t.Fatalf("set 1: status %d", rec.Code)
	}
	if p.GetNext() == nil {
		t.Fatal("first pick under limit 1 = nil")
	}
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("second pick under limit 1 = %s, want none", acc.ID)
	}
	if rec := post(`{"accountRpmLimit":0}`); rec.Code != http.StatusOK {
		t.Fatalf("turn off: status %d", rec.Code)
	}
	if p.GetNext() == nil {
		t.Fatal("pick with the limit off = nil")
	}
}

func TestNoAccountErrorAllAtRPMLimitIs429(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "hello")
	})
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	send := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		body := `{"model":"claude-sonnet-4.5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
		return rec
	}
	if rec := send(); rec.Code != http.StatusOK {
		t.Fatalf("first request: status %d body %s", rec.Code, rec.Body.String())
	}
	rec := send()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request in the same minute: status %d body %s, want 429", rec.Code, rec.Body.String())
	}
	var payload struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if payload.Error.Type != "rate_limit_error" || !strings.Contains(payload.Error.Message, "1 requests per minute") {
		t.Fatalf("error = %+v, want rate_limit_error naming the limit", payload.Error)
	}

	status, errType, _ := h.noAccountError(context.Background(), "claude-sonnet-4.5", "server_error")
	if status != http.StatusTooManyRequests || errType != "rate_limit_error" {
		t.Fatalf("noAccountError for the OpenAI APIs = %d %s, want 429 rate_limit_error", status, errType)
	}

	// The limit off again: a busy-pool answer is the usual 503, not a 429.
	clearRPMStarts(h.pool)
	h.pool.RecordQuotaError("responses-account", time.Hour)
	t.Cleanup(func() { h.pool.RecordSuccess("responses-account") })
	if status, _, _ := h.noAccountError(context.Background(), "claude-sonnet-4.5", "server_error"); status != http.StatusServiceUnavailable {
		t.Fatalf("noAccountError with the limit off and the account cooling down = %d, want 503", status)
	}
}

func TestDirectWebSearchAllAtRPMLimitIs429(t *testing.T) {
	h := newStreamTestHandler(t, func(http.ResponseWriter, *http.Request) {
		t.Error("direct web search must not call the model")
	})
	stubMCPWebSearch(t, http.StatusOK, mcpOneResult)
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	send := func() *httptest.ResponseRecorder {
		return postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,
			"tools":[{"type":"web_search_20250305","name":"web_search"}],
			"messages":[{"role":"user","content":"Perform a web search for the query: go"}]}`)
	}
	if rec := send(); rec.Code != http.StatusOK {
		t.Fatalf("first search: status %d body %s", rec.Code, rec.Body.String())
	}
	rec := send()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second search in the same minute: status %d body %s, want 429", rec.Code, rec.Body.String())
	}
	var payload struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if payload.Error.Type != "rate_limit_error" || !strings.Contains(payload.Error.Message, "1 requests per minute") {
		t.Fatalf("error = %+v, want rate_limit_error naming the limit", payload.Error)
	}
}

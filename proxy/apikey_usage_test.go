package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func setupApiKeyUsageTest(t *testing.T) {
	t.Helper()
	resetObservePersistenceForTest(t)
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
}

type usageRow struct {
	ts       int64
	keyID    string
	key      string
	success  bool
	in, out  int
	credits  float64
	repeated int
}

func insertUsageRows(t *testing.T, rows ...usageRow) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		success := 0
		if row.success {
			success = 1
		}
		times := row.repeated
		if times == 0 {
			times = 1
		}
		for i := 0; i < times; i++ {
			if _, err := d.Exec(`INSERT INTO requests (ts, api_key_id, api_key, in_tokens, out_tokens, total_tokens, credits, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				row.ts, row.keyID, row.key, row.in, row.out, row.in+row.out, row.credits, success); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func mustUsage(t *testing.T, now time.Time, rangeName string, tz int) apiKeyUsageResponse {
	t.Helper()
	rng, ok := parseUsageRange(rangeName)
	if !ok {
		t.Fatalf("range %q", rangeName)
	}
	resp, err := queryApiKeyUsage(now, rng, tz, config.ListApiKeys())
	if err != nil {
		t.Fatalf("queryApiKeyUsage: %v", err)
	}
	return resp
}

func usageEntry(t *testing.T, resp apiKeyUsageResponse, kind, id string) apiKeyUsageEntry {
	t.Helper()
	for _, e := range resp.Keys {
		if e.Kind == kind && e.ID == id {
			return e
		}
	}
	t.Fatalf("no %s entry %q in %+v", kind, id, resp.Keys)
	return apiKeyUsageEntry{}
}

func addUsageKey(t *testing.T, name, key string, enabled bool) config.ApiKeyEntry {
	t.Helper()
	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: name, Key: key, Enabled: enabled})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	return entry
}

func TestApiKeyUsageHourlyBuckets(t *testing.T) {
	setupApiKeyUsageTest(t)
	key := addUsageKey(t, "team", "sk-hourly-0123456789abcdef", true)

	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	thisHour := time.Date(2026, 3, 10, 14, 0, 0, 0, time.UTC).Unix()
	from := thisHour - 23*3600
	insertUsageRows(t,
		usageRow{ts: from - 1, keyID: key.ID, success: true},                                // before the range
		usageRow{ts: from, keyID: key.ID, success: true, in: 10, out: 5, credits: 0.5},      // first bucket
		usageRow{ts: thisHour - 1, keyID: key.ID, success: false, credits: 0.1},             // 13:59:59
		usageRow{ts: thisHour - 3600, keyID: key.ID, success: true, in: 1, out: 2},          // 13:00:00
		usageRow{ts: thisHour, keyID: key.ID, success: true, in: 100, out: 40, repeated: 2}, // 14:00:00
		usageRow{ts: now.Unix(), keyID: key.ID, success: false},                             // the partial hour
		usageRow{ts: thisHour + 3600, keyID: key.ID, success: true},                         // after now: excluded
	)

	resp := mustUsage(t, now, "24h", 0)
	if resp.Range != "24h" || resp.Bucket != "hour" || resp.BucketSeconds != 3600 {
		t.Fatalf("range %q bucket %q size %d", resp.Range, resp.Bucket, resp.BucketSeconds)
	}
	if resp.From != from || resp.To != thisHour+3600 || len(resp.Buckets) != 24 {
		t.Fatalf("from %d to %d buckets %d; want %d %d 24", resp.From, resp.To, len(resp.Buckets), from, thisHour+3600)
	}
	if resp.Buckets[0] != from || resp.Buckets[23] != thisHour {
		t.Fatalf("bucket starts %d..%d", resp.Buckets[0], resp.Buckets[23])
	}
	if len(resp.Keys) != 1 {
		t.Fatalf("keys = %+v", resp.Keys)
	}
	e := usageEntry(t, resp, usageKindKey, key.ID)
	if len(e.Series) != 24 {
		t.Fatalf("series length %d", len(e.Series))
	}
	if got := e.Series[0]; got.Requests != 1 || got.Succeeded != 1 || got.Tokens != 15 || got.Credits != 0.5 {
		t.Fatalf("first bucket %+v", got)
	}
	if got := e.Series[22]; got.Requests != 2 || got.Succeeded != 1 || got.Failed != 1 || got.InTokens != 1 || got.OutTokens != 2 {
		t.Fatalf("13:00 bucket %+v", got)
	}
	if got := e.Series[23]; got.Requests != 3 || got.Succeeded != 2 || got.Failed != 1 || got.InTokens != 200 || got.OutTokens != 80 || got.Tokens != 280 {
		t.Fatalf("14:00 bucket %+v", got)
	}
	for i := 1; i < 22; i++ {
		if e.Series[i] != (apiKeyUsageTotals{}) {
			t.Fatalf("bucket %d not empty: %+v", i, e.Series[i])
		}
	}
	if e.Totals.Requests != 6 || e.Totals.Failed != 2 || resp.Totals != e.Totals {
		t.Fatalf("totals %+v, response totals %+v", e.Totals, resp.Totals)
	}
	if e.Name != "team" || e.KeyMasked != config.MaskApiKey(key.Key) {
		t.Fatalf("name %q masked %q", e.Name, e.KeyMasked)
	}
}

func TestApiKeyUsageDailyBucketsTzOffset(t *testing.T) {
	setupApiKeyUsageTest(t)
	key := addUsageKey(t, "", "sk-daily-0123456789abcdef", true)

	// 02:30 UTC is 08:00 on 10 March in India (+05:30) and 21:30 on 9 March in New York (-05:00).
	now := time.Date(2026, 3, 10, 2, 30, 0, 0, time.UTC)
	istMidnight := time.Date(2026, 3, 9, 18, 30, 0, 0, time.UTC).Unix()
	insertUsageRows(t,
		usageRow{ts: istMidnight - 1, keyID: key.ID, success: true},           // 9 March 23:59:59 IST
		usageRow{ts: istMidnight, keyID: key.ID, success: true, repeated: 2},  // 10 March 00:00 IST
		usageRow{ts: istMidnight - 6*86400, keyID: key.ID, success: true},     // 4 March 00:00 IST: first day
		usageRow{ts: istMidnight - 6*86400 - 1, keyID: key.ID, success: true}, // 3 March: outside 7d
	)

	ist := mustUsage(t, now, "7d", 330)
	if ist.Bucket != "day" || len(ist.Buckets) != 7 || ist.TZOffset != 330 {
		t.Fatalf("bucket %q n %d tz %d", ist.Bucket, len(ist.Buckets), ist.TZOffset)
	}
	if ist.From != istMidnight-6*86400 || ist.To != istMidnight+86400 || ist.Buckets[6] != istMidnight {
		t.Fatalf("IST from %d to %d last %d", ist.From, ist.To, ist.Buckets[6])
	}
	e := usageEntry(t, ist, usageKindKey, key.ID)
	if e.Series[6].Requests != 2 || e.Series[5].Requests != 1 || e.Series[0].Requests != 1 || e.Totals.Requests != 4 {
		t.Fatalf("IST series %+v", e.Series)
	}

	// UTC: every row from 9 March falls on the 9th; today (the 10th) is empty so far.
	utc := mustUsage(t, now, "7d", 0)
	utcMidnight := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC).Unix()
	if utc.Buckets[6] != utcMidnight {
		t.Fatalf("UTC last bucket %d, want %d", utc.Buckets[6], utcMidnight)
	}
	e = usageEntry(t, utc, usageKindKey, key.ID)
	if e.Series[6].Requests != 0 || e.Series[5].Requests != 3 {
		t.Fatalf("UTC series %+v", e.Series)
	}

	// New York: it is still 9 March there, so the 9th is the last, partial day.
	ny := mustUsage(t, now, "7d", -300)
	nyMidnight := time.Date(2026, 3, 9, 5, 0, 0, 0, time.UTC).Unix()
	if ny.Buckets[6] != nyMidnight || ny.To != nyMidnight+86400 {
		t.Fatalf("NY last bucket %d to %d, want %d", ny.Buckets[6], ny.To, nyMidnight)
	}
	e = usageEntry(t, ny, usageKindKey, key.ID)
	if e.Series[6].Requests != 3 {
		t.Fatalf("NY series %+v", e.Series)
	}

	month := mustUsage(t, now, "30d", 330)
	if len(month.Buckets) != 30 || month.From != istMidnight-29*86400 {
		t.Fatalf("30d buckets %d from %d", len(month.Buckets), month.From)
	}
	if e := usageEntry(t, month, usageKindKey, key.ID); e.Totals.Requests != 5 || len(e.Series) != 30 {
		t.Fatalf("30d totals %+v series %d", e.Totals, len(e.Series))
	}
}

func TestApiKeyUsageGroupsNoneInvalidDeletedRejected(t *testing.T) {
	setupApiKeyUsageTest(t)
	active := addUsageKey(t, "ci a@example.com", "sk-active-0123456789abcdef", true)
	blocked := addUsageKey(t, "", "sk-blocked-0123456789abcdef", false)

	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	ts := now.Unix() - 60
	insertUsageRows(t,
		// Served with the current value and with the value before a rotation: one key.
		usageRow{ts: ts, keyID: active.ID, key: active.Key, success: true, credits: 1},
		usageRow{ts: ts, keyID: active.ID, key: "sk-rotated-away-0123456789", success: true, credits: 1},
		// Rejected for being disabled: no key ID, the raw value names the key.
		usageRow{ts: ts, key: blocked.Key, success: false},
		// Made-up keys: one invalid row, whatever value each sent.
		usageRow{ts: ts, key: "sk-made-up-0000000000000001", success: false},
		usageRow{ts: ts, key: "sk-made-up-0000000000000002", success: false},
		// Requirement off: no key at all.
		usageRow{ts: ts, success: true, credits: 0.25, repeated: 3},
		// A key deleted since.
		usageRow{ts: ts, keyID: "gone-key-id", key: "sk-deleted-0123456789abcdef", success: true, credits: 2},
	)

	resp := mustUsage(t, now, "24h", 0)
	if len(resp.Keys) != 5 {
		t.Fatalf("entries %+v", resp.Keys)
	}
	// Requests first, then credits.
	order := make([]string, len(resp.Keys))
	for i, e := range resp.Keys {
		order[i] = e.Kind + ":" + e.ID
	}
	want := []string{"none:none", "key:" + active.ID, "invalid:invalid", "deleted:gone-key-id", "key:" + blocked.ID}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("order %v, want %v", order, want)
	}

	if e := usageEntry(t, resp, usageKindKey, active.ID); e.Totals.Requests != 2 || e.Totals.Credits != 2 || e.Name != active.Name {
		t.Fatalf("active %+v", e)
	}
	if e := usageEntry(t, resp, usageKindKey, blocked.ID); e.Totals.Requests != 1 || e.Totals.Failed != 1 || e.KeyMasked != config.MaskApiKey(blocked.Key) {
		t.Fatalf("blocked %+v", e)
	}
	if e := usageEntry(t, resp, usageKindInvalid, usageKindInvalid); e.Totals.Requests != 2 || e.Totals.Failed != 2 || e.KeyMasked != "" || e.Name != "" {
		t.Fatalf("invalid %+v", e)
	}
	if e := usageEntry(t, resp, usageKindNone, usageKindNone); e.Totals.Requests != 3 || e.Totals.Succeeded != 3 {
		t.Fatalf("none %+v", e)
	}
	if e := usageEntry(t, resp, usageKindDeleted, "gone-key-id"); e.Totals.Requests != 1 || e.KeyMasked != config.MaskApiKey("sk-deleted-0123456789abcdef") || e.Name != "" {
		t.Fatalf("deleted %+v", e)
	}
	if resp.Totals.Requests != 9 || resp.Totals.Failed != 3 {
		t.Fatalf("totals %+v", resp.Totals)
	}
}

func TestApiKeyUsageNeverReturnsRawKeys(t *testing.T) {
	setupApiKeyUsageTest(t)
	config.SetPassword("admin-password")
	h := newHandlerWithoutBackgroundForTest(t)
	now := time.Now()
	pinObserveClock(t, now)

	active := addUsageKey(t, "a", "sk-secret-active-0123456789abcdef", true)
	blocked := addUsageKey(t, "b", "sk-secret-blocked-0123456789abcdef", false)
	raws := []string{active.Key, blocked.Key, "sk-secret-rotated-0123456789", "sk-secret-invalid-0123456789", "sk-secret-deleted-0123456789"}
	ts := now.Unix() - 30
	insertUsageRows(t,
		usageRow{ts: ts, keyID: active.ID, key: active.Key, success: true},
		usageRow{ts: ts, keyID: active.ID, key: raws[2], success: true},
		usageRow{ts: ts, key: blocked.Key},
		usageRow{ts: ts, key: raws[3]},
		usageRow{ts: ts, keyID: "gone", key: raws[4], success: true},
	)

	for _, rng := range []string{"24h", "7d", "30d"} {
		rec := serveUsageAdmin(h, "/admin/api/api-keys/usage?range="+rng+"&tzOffset=-300")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d body %s", rng, rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		for _, raw := range raws {
			if strings.Contains(body, raw) {
				t.Fatalf("%s: response carries raw key %q: %s", rng, raw, body)
			}
		}
		if !strings.Contains(body, config.MaskApiKey(raws[4])) {
			t.Fatalf("%s: deleted key not masked in %s", rng, body)
		}
	}
}

func serveUsageAdmin(h *Handler, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestApiKeyUsageRejectsBadParams(t *testing.T) {
	setupApiKeyUsageTest(t)
	h := &Handler{}
	cases := []struct {
		query, code string
	}{
		{"range=1h", codeInvalidUsageRange},
		{"range=24H", codeInvalidUsageRange},
		{"range=7d&tzOffset=abc", codeInvalidTZOffset},
		{"range=7d&tzOffset=1.5", codeInvalidTZOffset},
		{"range=7d&tzOffset=841", codeInvalidTZOffset},
		{"range=7d&tzOffset=-841", codeInvalidTZOffset},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h.apiApiKeyUsage(rec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/usage?"+tc.query, nil))
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusBadRequest || body["code"] != tc.code {
			t.Fatalf("%s: status %d body %s, want 400 %s", tc.query, rec.Code, rec.Body.String(), tc.code)
		}
	}

	for _, query := range []string{"", "range=30d&tzOffset=840", "range=24h&tzOffset=-840"} {
		rec := httptest.NewRecorder()
		h.apiApiKeyUsage(rec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/usage?"+query, nil))
		var resp apiKeyUsageResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("%q: status %d body %s", query, rec.Code, rec.Body.String())
		}
		if query == "" && (resp.Range != "24h" || resp.TZOffset != 0 || len(resp.Buckets) != 24) {
			t.Fatalf("defaults %+v", resp)
		}
		if resp.Keys == nil {
			t.Fatalf("%q: keys must be [] when empty: %s", query, rec.Body.String())
		}
	}
}

func TestApiKeyUsageRouteBeforeKeyLookup(t *testing.T) {
	setupApiKeyUsageTest(t)
	config.SetPassword("admin-password")
	h := newHandlerWithoutBackgroundForTest(t)
	key := addUsageKey(t, "route", "sk-route-0123456789abcdef", true)

	rec := serveUsageAdmin(h, "/admin/api/api-keys/usage?range=7d")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"range":"7d"`) {
		t.Fatalf("usage route: status %d body %s", rec.Code, rec.Body.String())
	}
	// The key lookup still answers for a real ID.
	rec = serveUsageAdmin(h, "/admin/api/api-keys/"+key.ID)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), key.ID) {
		t.Fatalf("key route: status %d body %s", rec.Code, rec.Body.String())
	}
	// Admin auth still guards it.
	req := httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/usage", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: status %d", rec.Code)
	}
}

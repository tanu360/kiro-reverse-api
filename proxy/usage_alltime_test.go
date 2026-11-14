package proxy

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func civilDay(year int, month time.Month, d int) int64 {
	return time.Date(year, month, d, 0, 0, 0, 0, time.UTC).Unix() / daySeconds
}

func TestLifetimeLayoutPicksTheBucketBySpan(t *testing.T) {
	today := civilDay(2026, time.November, 14) // a Saturday
	cases := []struct {
		name     string
		first    int64
		bucket   string
		buckets  int
		firstDay int64
	}{
		{"today only: a week of days", today, "day", 7, today - 6},
		{"a 10-day log", today - 9, "day", 10, today - 9},
		{"60 days", today - 59, "day", 60, today - 59},
		{"61 days: weeks", today - 60, "week", 9, civilDay(2026, time.September, 14)},
		{"about 14 months: weeks", civilDay(2025, time.September, 22), "week", 60, civilDay(2025, time.September, 22)},
		{"a week more: months", civilDay(2025, time.September, 15), "month", 15, civilDay(2025, time.September, 1)},
		{"5 years: months", civilDay(2021, time.December, 31), "month", 60, civilDay(2021, time.December, 1)},
		{"longer: years", civilDay(2021, time.November, 30), "year", 6, civilDay(2021, time.January, 1)},
		{"a row at the epoch: years", 0, "year", 57, 0},
	}
	for _, tc := range cases {
		l := newLifetimeLayout(tc.first, today)
		if l.bucket != tc.bucket || len(l.starts) != tc.buckets || l.starts[0] != tc.firstDay {
			t.Fatalf("%s: %s × %d from day %d; want %s × %d from %d", tc.name, l.bucket, len(l.starts), l.starts[0], tc.bucket, tc.buckets, tc.firstDay)
		}
		if len(l.starts) > maxLifetimeBuckets {
			t.Fatalf("%s: %d buckets", tc.name, len(l.starts))
		}
		if got := l.index(today); got != len(l.starts)-1 {
			t.Fatalf("%s: today in bucket %d of %d", tc.name, got, len(l.starts))
		}
		if got := l.index(tc.first); tc.first != today && got != 0 {
			t.Fatalf("%s: the first day in bucket %d", tc.name, got)
		}
		if l.index(l.starts[0]-1) != -1 || l.index(l.end) != -1 {
			t.Fatalf("%s: a day outside the grid has a bucket", tc.name)
		}
		for i, start := range l.starts {
			if l.index(start) != i {
				t.Fatalf("%s: bucket %d starts on day %d, which maps to %d", tc.name, i, start, l.index(start))
			}
			if i > 0 && l.index(start-1) != i-1 {
				t.Fatalf("%s: the day before bucket %d maps to %d", tc.name, i, l.index(start-1))
			}
		}
		if tc.bucket == "week" {
			for _, start := range l.starts {
				if dayDate(start).Weekday() != time.Monday {
					t.Fatalf("%s: a week starts on %s", tc.name, dayDate(start).Weekday())
				}
			}
		}
	}
}

func TestLocalDayAndWeekStart(t *testing.T) {
	// 2026-03-10 00:30 at UTC+5:30 is still 2026-03-09 in UTC.
	ts := time.Date(2026, 3, 9, 19, 0, 0, 0, time.UTC).Unix()
	if got, want := localDay(ts, 330*60), civilDay(2026, time.March, 10); got != want {
		t.Fatalf("localDay = %d, want %d", got, want)
	}
	if got, want := localDay(ts, -300*60), civilDay(2026, time.March, 9); got != want {
		t.Fatalf("localDay west = %d, want %d", got, want)
	}
	for d := civilDay(2026, time.March, 9); d < civilDay(2026, time.March, 16); d++ {
		if got := weekStart(d); got != civilDay(2026, time.March, 9) {
			t.Fatalf("weekStart(%s) = %s", dayDate(d).Format("Mon Jan 2"), dayDate(got).Format("Mon Jan 2"))
		}
	}
	// 1969-12-31 was a Wednesday, 1969-12-28 a Sunday.
	if weekStart(-1) != -3 || weekStart(-4) != -10 {
		t.Fatalf("weekStart before the epoch = %d, %d", weekStart(-1), weekStart(-4))
	}
}

func approxTotals(a, b apiKeyUsageTotals) bool {
	return a.Requests == b.Requests && a.Succeeded == b.Succeeded && a.Failed == b.Failed &&
		a.InTokens == b.InTokens && a.OutTokens == b.OutTokens && a.Tokens == b.Tokens &&
		math.Abs(a.Credits-b.Credits) < 1e-9
}

// seedAllTimeUsage logs requests from 0 to 200 days ago for a configured key, a key that was
// deleted, an invalid key and no key, so a 30-day retention prunes some of each.
func seedAllTimeUsage(t *testing.T, now time.Time, live config.ApiKeyEntry) {
	t.Helper()
	ages := []int64{0, 1, 5, 12, 29, 31, 45, 90, 120, 200}
	for i, age := range ages {
		ts := now.Unix() - age*daySeconds - int64(i)*37
		insertUsageRows(t,
			usageRow{ts: ts, keyID: live.ID, success: true, in: 10 + i, out: 3, credits: 0.25, repeated: 2},
			usageRow{ts: ts - 60, keyID: live.ID, success: false, credits: 0.01},
			usageRow{ts: ts - 120, keyID: "gone-key", key: "sk-gone****abcd", success: true, in: 4, out: 4, credits: 0.5},
			usageRow{ts: ts - 180, key: "sk-bad****wxyz", success: false},
			usageRow{ts: ts - 240, success: true, in: 1, out: 1, credits: 0.125},
		)
	}
}

func usageByRef(resp apiKeyUsageResponse) map[string]apiKeyUsageEntry {
	out := make(map[string]apiKeyUsageEntry, len(resp.Keys))
	for _, e := range resp.Keys {
		out[e.Kind+":"+e.ID] = e
	}
	return out
}

// Pruning moves rows into the rollups by day: All time keeps every total and every bucket, per
// key and for the invalid, deleted and no-key groups, and still covers 30d plus what was pruned.
func TestApiKeyUsageAllTimeSurvivesPruning(t *testing.T) {
	setupApiKeyUsageTest(t)
	live := addUsageKey(t, "build", "sk-alltime-0123456789abcdef", true)
	now := time.Date(2026, 11, 14, 15, 0, 0, 0, time.UTC)
	seedAllTimeUsage(t, now, live)

	for _, tz := range []int{0, 330, -480} {
		before := mustUsage(t, now, "all", tz)
		if before.Range != "all" || before.Bucket != "week" || before.Earlier != nil {
			t.Fatalf("tz %d: range %q bucket %q earlier %+v", tz, before.Range, before.Bucket, before.Earlier)
		}
		if before.Totals.Requests != 60 || len(before.Keys) != 4 {
			t.Fatalf("tz %d: %d requests over %d entries; want 60 over 4", tz, before.Totals.Requests, len(before.Keys))
		}
		var sum apiKeyUsageTotals
		for _, e := range before.Keys {
			for _, b := range e.Series {
				sum.add(b)
			}
		}
		if !approxTotals(sum, before.Totals) {
			t.Fatalf("tz %d: the buckets add up to %+v, the totals say %+v", tz, sum, before.Totals)
		}
	}
	before := mustUsage(t, now, "all", 0)
	month := mustUsage(t, now, "30d", 0)

	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	pruned, _, err := pruneRequestLog(now, 30, nil)
	if err != nil || pruned != 30 {
		t.Fatalf("prune = %d, %v; want 30 rows", pruned, err)
	}

	after := mustUsage(t, now, "all", 0)
	if after.Earlier != nil || !approxTotals(after.Totals, before.Totals) {
		t.Fatalf("totals after the prune %+v (earlier %+v), before %+v", after.Totals, after.Earlier, before.Totals)
	}
	if after.From != before.From || len(after.Buckets) != len(before.Buckets) {
		t.Fatalf("grid moved: %d × %d, was %d × %d", after.From, len(after.Buckets), before.From, len(before.Buckets))
	}
	was := usageByRef(before)
	for ref, e := range usageByRef(after) {
		old, ok := was[ref]
		if !ok {
			t.Fatalf("entry %s appeared after the prune", ref)
		}
		if !approxTotals(e.Totals, old.Totals) {
			t.Fatalf("%s: totals %+v, were %+v", ref, e.Totals, old.Totals)
		}
		for i := range e.Series {
			if !approxTotals(e.Series[i], old.Series[i]) {
				t.Fatalf("%s bucket %d: %+v, was %+v", ref, i, e.Series[i], old.Series[i])
			}
		}
	}
	if len(after.Keys) != len(before.Keys) {
		t.Fatalf("%d entries after the prune, %d before", len(after.Keys), len(before.Keys))
	}
	// The deleted key's last value is in a row the prune kept.
	if e := usageEntry(t, after, usageKindDeleted, "gone-key"); e.KeyMasked != config.MaskApiKey("sk-gone****abcd") {
		t.Fatalf("deleted key masked %q", e.KeyMasked)
	}

	// All time = 30d + the pruned rows (no row sits between the 30-day window and the cutoff).
	if after.Totals.Requests != month.Totals.Requests+pruned {
		t.Fatalf("all time %d, 30d %d + pruned %d", after.Totals.Requests, month.Totals.Requests, pruned)
	}
	if got := mustUsage(t, now, "30d", 0); !approxTotals(got.Totals, month.Totals) {
		t.Fatalf("30d after the prune %+v, before %+v", got.Totals, month.Totals)
	}
}

// With a short retention, the daily ranges read the pruned days back from the daily rollup.
func TestApiKeyUsageDailyRangesCountPrunedDays(t *testing.T) {
	setupApiKeyUsageTest(t)
	live := addUsageKey(t, "build", "sk-pruned7d-0123456789abcdef", true)
	now := time.Date(2026, 11, 14, 15, 0, 0, 0, time.UTC)
	seedAllTimeUsage(t, now, live)

	week := mustUsage(t, now, "7d", 0)
	month := mustUsage(t, now, "30d", 0)
	if err := config.UpdateLogRetentionDays(2); err != nil {
		t.Fatal(err)
	}
	if n, _, err := pruneRequestLog(now, 2, nil); err != nil || n != 48 {
		t.Fatalf("prune = %d, %v; want 48", n, err)
	}
	for _, tc := range []struct {
		name string
		want apiKeyUsageResponse
	}{{"7d", week}, {"30d", month}} {
		got := mustUsage(t, now, tc.name, 0)
		if !approxTotals(got.Totals, tc.want.Totals) {
			t.Fatalf("%s after the prune %+v, before %+v", tc.name, got.Totals, tc.want.Totals)
		}
		was := usageByRef(tc.want)
		for ref, e := range usageByRef(got) {
			for i := range e.Series {
				if !approxTotals(e.Series[i], was[ref].Series[i]) {
					t.Fatalf("%s %s bucket %d: %+v, was %+v", tc.name, ref, i, e.Series[i], was[ref].Series[i])
				}
			}
		}
	}
}

// Rows pruned before the daily rollup existed have no day: they count in the totals and in
// earlier, never in a bucket. Without a key ID they count under no key.
func TestApiKeyUsageAllTimeShowsUndatedRowsAsEarlier(t *testing.T) {
	setupApiKeyUsageTest(t)
	live := addUsageKey(t, "build", "sk-earlier-0123456789abcdef", true)
	now := time.Date(2026, 11, 14, 15, 0, 0, 0, time.UTC)
	insertUsageRows(t, usageRow{ts: now.Unix() - 3600, keyID: live.ID, success: true, in: 5, out: 5, credits: 1})
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	// What an earlier build's prune left: rollup totals with no day, and one group that later
	// got daily rows too.
	if _, err := d.Exec(`INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count, in_tokens, out_tokens, total_tokens, credits, last_ts) VALUES
('auto', 'acc-a', ?, 1, 12, 100, 20, 120, 1.5, 1),
('auto', 'acc-a', ?, 0, 3, 0, 0, 0, 0, 1),
('auto', '', '', 0, 4, 0, 0, 0, 0, 1),
('auto', 'acc-a', '', 1, 2, 1, 1, 2, 0.25, 1)`, live.ID, live.ID); err != nil {
		t.Fatal(err)
	}
	pruneDay := now.Unix()/daySeconds - 40
	if _, err := d.Exec(`UPDATE request_rollup SET request_count = request_count + 5, in_tokens = in_tokens + 50, credits = credits + 0.5 WHERE api_key_id = ? AND success = 1`, live.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO request_rollup_daily (day, model, account_id, api_key_id, keyless, success, request_count, in_tokens, credits) VALUES (?, 'auto', 'acc-a', ?, 0, 1, 5, 50, 0.5)`, pruneDay, live.ID); err != nil {
		t.Fatal(err)
	}

	resp := mustUsage(t, now, "all", 0)
	if resp.Totals.Requests != 1+17+3+4+2 {
		t.Fatalf("totals %+v", resp.Totals)
	}
	if resp.Earlier == nil || resp.Earlier.Requests != 21 {
		t.Fatalf("earlier %+v, want 21 requests", resp.Earlier)
	}
	key := usageEntry(t, resp, usageKindKey, live.ID)
	if key.Totals.Requests != 21 || key.Totals.Succeeded != 18 || key.Totals.Failed != 3 || math.Abs(key.Totals.Credits-3) > 1e-9 {
		t.Fatalf("key totals %+v", key.Totals)
	}
	if key.Earlier == nil || key.Earlier.Requests != 15 || key.Earlier.InTokens != 100 || math.Abs(key.Earlier.Credits-1.5) > 1e-9 {
		t.Fatalf("key earlier %+v", key.Earlier)
	}
	var inBuckets int64
	for _, b := range key.Series {
		inBuckets += b.Requests
	}
	if inBuckets != 6 {
		t.Fatalf("key buckets hold %d requests, want 6 (1 logged + 5 pruned by day)", inBuckets)
	}
	if idx := (pruneDay - resp.Buckets[0]/daySeconds); resp.Bucket != "day" || key.Series[idx].Requests != 5 {
		t.Fatalf("bucket %s: day %d holds %+v", resp.Bucket, idx, key.Series)
	}
	none := usageEntry(t, resp, usageKindNone, usageKindNone)
	if none.Totals.Requests != 6 || none.Earlier == nil || none.Earlier.Requests != 6 {
		t.Fatalf("no key %+v", none)
	}
	for _, b := range none.Series {
		if b.Requests != 0 {
			t.Fatalf("undated rows reached a bucket: %+v", none.Series)
		}
	}
}

func insertErrorRows(t *testing.T, ts ...int64) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range ts {
		if _, err := d.Exec(`INSERT INTO errors (ts, account_id, model, status, message) VALUES (?, 'acc-a', 'auto', 500, 'boom')`, at); err != nil {
			t.Fatal(err)
		}
	}
}

// The Overview's all-time traffic: every logged request and retry, the same after a prune, and
// the same as the lifetime totals.
func TestTrafficHistorySurvivesPruningAndMatchesLifetime(t *testing.T) {
	setupApiKeyUsageTest(t)
	live := addUsageKey(t, "build", "sk-traffic-0123456789abcdef", true)
	now := time.Date(2026, 11, 14, 15, 0, 0, 0, time.UTC)
	seedAllTimeUsage(t, now, live)
	insertErrorRows(t, now.Unix()-10, now.Unix()-3*daySeconds, now.Unix()-50*daySeconds, now.Unix()-150*daySeconds, now.Unix()-150*daySeconds-5)

	before, err := queryTrafficHistory(now, 120)
	if err != nil {
		t.Fatal(err)
	}
	want := trafficCounts{Succeeded: 40, Failed: 20, Retried: 5}
	if before.Totals != want || before.Earlier != nil || before.Bucket != "week" {
		t.Fatalf("before: totals %+v earlier %+v bucket %s", before.Totals, before.Earlier, before.Bucket)
	}
	if len(before.Series) != len(before.Buckets) || before.To <= now.Unix() || before.From > now.Unix()-200*daySeconds {
		t.Fatalf("grid %d..%d with %d buckets, %d values", before.From, before.To, len(before.Buckets), len(before.Series))
	}

	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	if reqs, errs, err := pruneRequestLog(now, 30, nil); err != nil || reqs != 30 || errs != 3 {
		t.Fatalf("prune = %d, %d, %v", reqs, errs, err)
	}
	after, err := queryTrafficHistory(now, 120)
	if err != nil {
		t.Fatal(err)
	}
	if after.Totals != want || after.Earlier != nil {
		t.Fatalf("after: totals %+v earlier %+v", after.Totals, after.Earlier)
	}
	for i := range after.Series {
		if after.Series[i] != before.Series[i] {
			t.Fatalf("bucket %d: %+v, was %+v", i, after.Series[i], before.Series[i])
		}
	}
	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.SuccessRequests != after.Totals.Succeeded || stats.FailedRequests != after.Totals.Failed || stats.TotalErrorEvents != after.Totals.Retried {
		t.Fatalf("lifetime stats %+v, all-time traffic %+v", stats, after.Totals)
	}

	// Rollup rows from before the daily tables: totals and earlier, not buckets.
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count) VALUES ('m-old', 'acc-old', '', 1, 7), ('m-old', 'acc-old', '', 0, 2);
INSERT INTO error_rollup (model, account_id, error_count) VALUES ('m-old', 'acc-old', 4)`); err != nil {
		t.Fatal(err)
	}
	legacy, err := queryTrafficHistory(now, 120)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.Earlier == nil || *legacy.Earlier != (trafficCounts{Succeeded: 7, Failed: 2, Retried: 4}) {
		t.Fatalf("earlier %+v", legacy.Earlier)
	}
	if legacy.Totals != (trafficCounts{Succeeded: 47, Failed: 22, Retried: 9}) {
		t.Fatalf("totals with earlier %+v", legacy.Totals)
	}
	for i := range legacy.Series {
		if legacy.Series[i] != before.Series[i] {
			t.Fatalf("undated rows reached bucket %d", i)
		}
	}
}

func TestTrafficHistoryEmptyLogDrawsAWeek(t *testing.T) {
	setupApiKeyUsageTest(t)
	now := time.Date(2026, 11, 14, 15, 0, 0, 0, time.UTC)
	resp, err := queryTrafficHistory(now, 0)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Bucket != "day" || len(resp.Buckets) != 7 || len(resp.Series) != 7 || resp.Totals != (trafficCounts{}) || resp.Earlier != nil {
		t.Fatalf("empty log: %+v", resp)
	}
	if resp.Buckets[6] != time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC).Unix() || resp.To != resp.Buckets[6]+daySeconds {
		t.Fatalf("buckets %v to %d", resp.Buckets, resp.To)
	}
}

func TestAllTimeEndpoints(t *testing.T) {
	setupApiKeyUsageTest(t)
	config.SetPassword("admin-password")
	h := newHandlerWithoutBackgroundForTest(t)
	key := addUsageKey(t, "build", "sk-endpoint-0123456789abcdef", true)
	insertUsageRows(t, usageRow{ts: time.Now().Unix() - 100*daySeconds, keyID: key.ID, success: true})

	rec := adminRequest(t, h, http.MethodGet, "/api-keys/usage?range=all&tzOffset=-300", "")
	var usage apiKeyUsageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("usage all = %d %s", rec.Code, rec.Body.String())
	}
	if usage.Range != "all" || usage.Bucket != "week" || usage.TZOffset != -300 || usage.Totals.Requests != 1 {
		t.Fatalf("usage all %+v", usage)
	}

	rec = adminRequest(t, h, http.MethodGet, "/observe/traffic-history?tzOffset=60", "")
	var traffic trafficHistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &traffic); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("traffic history = %d %s", rec.Code, rec.Body.String())
	}
	if traffic.Range != "all" || traffic.Totals.Succeeded != 1 || traffic.TZOffset != 60 {
		t.Fatalf("traffic history %+v", traffic)
	}

	for _, target := range []string{"/observe/traffic-history?tzOffset=900", "/observe/traffic-history?tzOffset=x"} {
		rec = adminRequest(t, h, http.MethodGet, target, "")
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusBadRequest || body["code"] != codeInvalidTZOffset {
			t.Fatalf("%s = %d %s", target, rec.Code, rec.Body.String())
		}
	}
	rec = adminRequest(t, h, http.MethodGet, "/api-keys/usage?range=ALL", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("range=ALL = %d", rec.Code)
	}

	// Without the admin session: 401, as every admin route.
	req := httptest.NewRequest(http.MethodGet, "/admin/api/observe/traffic-history", nil)
	out := httptest.NewRecorder()
	h.ServeHTTP(out, req)
	if out.Code != http.StatusUnauthorized {
		t.Fatalf("no session = %d", out.Code)
	}
}

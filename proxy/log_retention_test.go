package proxy

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

const day = int64(86400)

// setupLogRetentionTest gives the test a fresh kiro.db and config, batches of
// 3 rows with no pause (so a prune takes several batches and upserts into rows
// it made itself), and a job state with no run and no kick.
func setupLogRetentionTest(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	batch, pause := logPruneBatch, logPruneBatchPause
	logPruneBatch, logPruneBatchPause = 3, 0
	resetLogRetentionState()
	t.Cleanup(func() {
		logPruneBatch, logPruneBatchPause = batch, pause
		resetLogRetentionState()
	})
}

func resetLogRetentionState() {
	logRetention.mu.Lock()
	logRetention.lastRunAt, logRetention.lastPrunedRequests, logRetention.lastPrunedErrors = 0, 0, 0
	logRetention.mu.Unlock()
	select {
	case <-logRetention.kick:
	default:
	}
}

// seedLogRows logs 60 requests and 30 errors aged 0 to 200 days before now,
// over every mix of model, account, key and outcome the stats group by,
// including the empty account and model of a rejected request.
func seedLogRows(t *testing.T, now int64) {
	t.Helper()
	conn, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	//! One transaction: a commit per row costs a disk sync each.
	d, err := conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer d.Rollback()
	models := []string{"claude-sonnet-4.5", "auto", "", "deepseek-3.2"}
	accounts := []string{"acc-a", "acc-b", ""}
	keys := []string{"key-1", "", "key-2", "key-1"}
	for i := int64(0); i < 60; i++ {
		ts := now - (i%6)*40*day - i*60
		success := 1
		if i%3 == 0 {
			success = 0
		}
		in, out := 10+i*7, 3+i
		apiKey := ""
		if keys[i%4] != "" {
			apiKey = "sk-secret-" + keys[i%4]
		}
		if _, err := d.Exec(`INSERT INTO requests
(ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, cache_read_tokens, cache_write_tokens)
VALUES (?, ?, ?, ?, 'x@y', ?, ?, ?, ?, ?, ?, 200, ?, ?)`,
			ts, accounts[i%3], keys[i%4], apiKey, models[i%4], in, out, in+out, 0.1*float64(i%7)+0.013*float64(i), success, (i*11)%50, i%5); err != nil {
			t.Fatal(err)
		}
	}
	for i := int64(0); i < 30; i++ {
		if _, err := d.Exec(`INSERT INTO errors (ts, account_id, email, model, status, message) VALUES (?, ?, 'x@y', ?, 500, 'boom')`,
			now-(i%5)*45*day-i, accounts[i%3], models[i%4]); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Commit(); err != nil {
		t.Fatal(err)
	}
}

func logCounts(t *testing.T, cutoff int64) (reqs, oldReqs, errs, oldErrs int64) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if err := d.QueryRow(`SELECT
(SELECT COUNT(*) FROM requests), (SELECT COUNT(*) FROM requests WHERE ts < ?),
(SELECT COUNT(*) FROM errors), (SELECT COUNT(*) FROM errors WHERE ts < ?)`, cutoff, cutoff).Scan(&reqs, &oldReqs, &errs, &oldErrs); err != nil {
		t.Fatal(err)
	}
	return reqs, oldReqs, errs, oldErrs
}

func closeEnough(a, b float64) bool {
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(a))
}

// assertSameStats compares counts and tokens exactly; credits are float sums,
// added up in a different order once part of them sits in the rollup.
func assertSameStats(t *testing.T, got, want persistedRequestStats) {
	t.Helper()
	if !closeEnough(got.TotalCredits, want.TotalCredits) || !closeEnough(got.SuccessCredits, want.SuccessCredits) {
		t.Fatalf("credits = %v / %v, want %v / %v", got.TotalCredits, got.SuccessCredits, want.TotalCredits, want.SuccessCredits)
	}
	got.TotalCredits, got.SuccessCredits = want.TotalCredits, want.SuccessCredits
	if got != want {
		t.Fatalf("stats = %+v\nwant    %+v", got, want)
	}
}

func assertSameModelStats(t *testing.T, got, want map[string]*modelStat) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("models = %d, want %d", len(got), len(want))
	}
	for model, w := range want {
		g, ok := got[model]
		if !ok {
			t.Fatalf("model %q missing", model)
		}
		if !closeEnough(g.Credits, w.Credits) {
			t.Fatalf("%s credits = %v, want %v", model, g.Credits, w.Credits)
		}
		gc := *g
		gc.Credits = w.Credits
		if gc != *w {
			t.Fatalf("%s = %+v, want %+v", model, gc, *w)
		}
	}
}

func lifetimeTotals(t *testing.T) (persistedRequestStats, map[string]*modelStat) {
	t.Helper()
	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatal(err)
	}
	maxReq, maxErr, err := maxLoggedIDs()
	if err != nil {
		t.Fatal(err)
	}
	models, err := loadModelStatsFromDB(maxReq, maxErr)
	if err != nil {
		t.Fatal(err)
	}
	return stats, models
}

func TestPruneRequestLogKeepsLifetimeTotals(t *testing.T) {
	setupLogRetentionTest(t)
	now := time.Unix(1_800_000_000, 0)
	seedLogRows(t, now.Unix())
	wantStats, wantModels := lifetimeTotals(t)
	if wantStats.TotalRequests != 60 || wantStats.TotalErrorEvents != 30 || len(wantModels) != 3 {
		t.Fatalf("seed = %+v, %d models", wantStats, len(wantModels))
	}
	maxReq, maxErr, err := maxLoggedIDs()
	if err != nil {
		t.Fatal(err)
	}

	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	cutoff := now.Unix() - 30*day
	_, oldReqs, _, oldErrs := logCounts(t, cutoff)
	reqs, errs, err := pruneRequestLog(now, 30, nil)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if reqs != oldReqs || errs != oldErrs || reqs != 50 || errs != 24 {
		t.Fatalf("pruned %d requests, %d errors; want %d, %d", reqs, errs, oldReqs, oldErrs)
	}
	left, leftOld, leftErrs, leftOldErrs := logCounts(t, cutoff)
	if left != 10 || leftOld != 0 || leftErrs != 6 || leftOldErrs != 0 {
		t.Fatalf("log after the prune = %d requests (%d old), %d errors (%d old)", left, leftOld, leftErrs, leftOldErrs)
	}

	gotStats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatal(err)
	}
	assertSameStats(t, gotStats, wantStats)
	//! The warmup's id bound comes from before the prune, as at startup.
	gotModels, err := loadModelStatsFromDB(maxReq, maxErr)
	if err != nil {
		t.Fatal(err)
	}
	assertSameModelStats(t, gotModels, wantModels)
}

func TestPruneRequestLogAccumulatesAcrossRuns(t *testing.T) {
	setupLogRetentionTest(t)
	now := time.Unix(1_800_000_000, 0)
	seedLogRows(t, now.Unix())
	wantStats, wantModels := lifetimeTotals(t)
	maxReq, maxErr, err := maxLoggedIDs()
	if err != nil {
		t.Fatal(err)
	}

	var pruned int64
	for _, days := range []int{150, 100, 30} {
		if err := config.UpdateLogRetentionDays(days); err != nil {
			t.Fatal(err)
		}
		reqs, _, err := pruneRequestLog(now, days, nil)
		if err != nil {
			t.Fatalf("prune %d days: %v", days, err)
		}
		if reqs == 0 {
			t.Fatalf("prune %d days removed nothing", days)
		}
		pruned += reqs
		gotStats, err := queryPersistedRequestStats()
		if err != nil {
			t.Fatal(err)
		}
		assertSameStats(t, gotStats, wantStats)
		gotModels, err := loadModelStatsFromDB(maxReq, maxErr)
		if err != nil {
			t.Fatal(err)
		}
		assertSameModelStats(t, gotModels, wantModels)
	}

	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var rollupRows, archived int64
	if err := d.QueryRow(`SELECT COUNT(*), COALESCE(SUM(request_count), 0) FROM request_rollup`).Scan(&rollupRows, &archived); err != nil {
		t.Fatal(err)
	}
	// Each group the three runs met has one rollup row: later runs added to it.
	// A seeded row's model and key follow i%4, its account and outcome i%3.
	seen := map[[2]int]bool{}
	for i := 0; i < 60; i++ {
		if i%6 != 0 {
			seen[[2]int{i % 4, i % 3}] = true
		}
	}
	groups := int64(len(seen))
	if archived != pruned || archived != 50 || rollupRows != groups {
		t.Fatalf("rollup = %d rows holding %d requests; want %d rows holding %d", rollupRows, archived, groups, pruned)
	}

	// A request logged after the prunes adds to the totals once.
	if err := persistRequestRecord(requestRecord{TS: now.Unix(), AccountID: "acc-a", Model: "auto", InTokens: 5, OutTokens: 2, TotalTokens: 7, Credits: 0.5, Success: true}); err != nil {
		t.Fatal(err)
	}
	gotStats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatal(err)
	}
	wantStats.TotalRequests++
	wantStats.SuccessRequests++
	wantStats.TotalTokens += 7
	wantStats.SuccessTokens += 7
	wantStats.SuccessInTokens += 5
	wantStats.SuccessOutTokens += 2
	wantStats.TotalCredits += 0.5
	wantStats.SuccessCredits += 0.5
	assertSameStats(t, gotStats, wantStats)
}

func TestPruneRequestLogKeepForeverIsNoop(t *testing.T) {
	setupLogRetentionTest(t)
	now := time.Unix(1_800_000_000, 0)
	seedLogRows(t, now.Unix())
	if err := config.UpdateLogRetentionDays(0); err != nil {
		t.Fatal(err)
	}

	reqs, errs, err := pruneRequestLog(now, 0, nil)
	if err != nil || reqs != 0 || errs != 0 {
		t.Fatalf("prune with 0 days = %d, %d, %v", reqs, errs, err)
	}
	runLogRetention(now, nil)
	if left, _, leftErrs, _ := logCounts(t, 0); left != 60 || leftErrs != 30 {
		t.Fatalf("log = %d requests, %d errors; want all 60, 30", left, leftErrs)
	}
	status, err := currentLogRetentionStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.LastRunAt != 0 || status.ArchivedRequests != 0 {
		t.Fatalf("keep forever ran a prune: %+v", status)
	}
}

func TestPruneRequestLogStopsWhenTheSettingChanges(t *testing.T) {
	setupLogRetentionTest(t)
	now := time.Unix(1_800_000_000, 0)
	seedLogRows(t, now.Unix())
	if err := config.UpdateLogRetentionDays(90); err != nil {
		t.Fatal(err)
	}

	// A run for 30 days while the saved setting already says 90: one batch, then stop.
	reqs, errs, err := pruneRequestLog(now, 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	if reqs != int64(logPruneBatch) || errs != 0 {
		t.Fatalf("pruned %d requests, %d errors; want one batch of %d", reqs, errs, logPruneBatch)
	}
}

func TestObserveWarmupCountsArchivedRows(t *testing.T) {
	setupLogRetentionTest(t)
	now := time.Unix(1_800_000_000, 0)
	pinObserveClock(t, now)
	seedLogRows(t, now.Unix())

	mixOf := func() map[string]ModelMixEntry {
		t.Helper()
		resetObservePersistenceForTest(t)
		s := getObserveStore()
		if err := s.LoadFromDB(); err != nil {
			t.Fatalf("LoadFromDB: %v", err)
		}
		mix := map[string]ModelMixEntry{}
		for _, m := range s.ModelMix() {
			mix[m.Model] = m
		}
		return mix
	}
	want := mixOf()

	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	if reqs, _, err := pruneRequestLog(now, 30, nil); err != nil || reqs != 50 {
		t.Fatalf("prune = %d, %v", reqs, err)
	}
	got := mixOf()
	if len(got) != len(want) || len(want) != 3 {
		t.Fatalf("model mix after a restart = %+v, want %+v", got, want)
	}
	for model, w := range want {
		g := got[model]
		if !closeEnough(g.Credits, w.Credits) {
			t.Fatalf("%s credits = %v, want %v", model, g.Credits, w.Credits)
		}
		g.Credits = w.Credits
		if g != w {
			t.Fatalf("%s = %+v, want %+v", model, g, w)
		}
	}
}

func adminRequest(t *testing.T, h *Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/admin/api"+path, strings.NewReader(body))
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestResetStatsClearsRollup(t *testing.T) {
	setupLogRetentionTest(t)
	config.SetPassword("admin-password")
	h := newHandlerWithoutBackgroundForTest(t)
	now := time.Now()
	seedLogRows(t, now.Unix())
	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	if reqs, errs, err := pruneRequestLog(now, 30, nil); err != nil || reqs == 0 || errs == 0 {
		t.Fatalf("prune = %d, %d, %v", reqs, errs, err)
	}

	if rec := adminRequest(t, h, http.MethodPost, "/stats/reset", ""); rec.Code != http.StatusOK {
		t.Fatalf("reset = %d %s", rec.Code, rec.Body.String())
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"requests", "errors", "request_rollup", "error_rollup"} {
		var n int
		if err := d.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s holds %d rows after a reset", table, n)
		}
	}
	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats != (persistedRequestStats{}) {
		t.Fatalf("stats after a reset = %+v", stats)
	}
}

func TestLogRetentionAPI(t *testing.T) {
	setupLogRetentionTest(t)
	config.SetPassword("admin-password")
	h := newHandlerWithoutBackgroundForTest(t)

	getStatus := func() logRetentionStatus {
		t.Helper()
		rec := adminRequest(t, h, http.MethodGet, "/log-retention", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET = %d %s", rec.Code, rec.Body.String())
		}
		var status logRetentionStatus
		if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		return status
	}
	if got := getStatus(); got != (logRetentionStatus{Days: 90, DefaultDays: 90, MaxDays: 3650}) {
		t.Fatalf("fresh status = %+v", got)
	}

	for _, days := range []int{30, 0} {
		body := `{"days":` + map[int]string{30: "30", 0: "0"}[days] + `}`
		if rec := adminRequest(t, h, http.MethodPost, "/log-retention", body); rec.Code != http.StatusOK {
			t.Fatalf("POST %s = %d %s", body, rec.Code, rec.Body.String())
		}
		if got := config.GetLogRetentionDays(); got != days {
			t.Fatalf("after POST %s the setting is %d", body, got)
		}
		select {
		case <-logRetention.kick:
		default:
			t.Fatalf("POST %s did not kick a run", body)
		}
		if got := getStatus().Days; got != days {
			t.Fatalf("GET days = %d, want %d", got, days)
		}
	}

	for body, code := range map[string]string{
		`{"days":-1}`:   codeLogRetentionRange,
		`{"days":3651}`: codeLogRetentionRange,
		`{}`:            codeLogRetentionRange,
		`{"days":null}`: codeLogRetentionRange,
		`{"days":1.5}`:  codeInvalidJSON,
		`{"days":"30"}`: codeInvalidJSON,
		`nope`:          codeInvalidJSON,
	} {
		rec := adminRequest(t, h, http.MethodPost, "/log-retention", body)
		if rec.Code != http.StatusBadRequest || decodeAdminError(t, rec)["code"] != code {
			t.Fatalf("POST %s = %d %s, want 400 %s", body, rec.Code, rec.Body.String(), code)
		}
	}
	if got := config.GetLogRetentionDays(); got != 0 {
		t.Fatalf("a rejected POST changed the setting to %d", got)
	}

	// A run shows in the status: when, what it pruned, what the rollup holds, the oldest row left.
	now := time.Unix(1_800_000_000, 0)
	seedLogRows(t, now.Unix())
	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}
	runLogRetention(now, nil)
	got := getStatus()
	want := logRetentionStatus{
		Days: 30, DefaultDays: 90, MaxDays: 3650,
		LastRunAt: now.Unix(), LastPrunedRequests: 50, LastPrunedErrors: 24,
		ArchivedRequests: 50, OldestRequestTs: now.Unix() - 54*60,
	}
	if got != want {
		t.Fatalf("status after a run = %+v\nwant %+v", got, want)
	}
}

func TestLogRetentionJobRunsOnKick(t *testing.T) {
	setupLogRetentionTest(t)
	delay := logRetentionStartDelay
	logRetentionStartDelay = time.Hour
	// One batch per table: this test is about the wiring, not the batching.
	logPruneBatch = 1000
	t.Cleanup(func() { logRetentionStartDelay = delay })
	seedLogRows(t, time.Now().Unix())
	if err := config.UpdateLogRetentionDays(30); err != nil {
		t.Fatal(err)
	}

	h := &Handler{stopStatsSaver: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		h.backgroundLogRetention()
		close(done)
	}()
	kickLogRetention()
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, err := currentLogRetentionStatus()
		if err != nil {
			t.Fatal(err)
		}
		if status.LastRunAt != 0 {
			if status.LastPrunedRequests != 50 || status.ArchivedRequests != 50 {
				t.Fatalf("status after the kicked run = %+v", status)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a kick did not run the prune")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(h.stopStatsSaver)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the job did not stop")
	}
}

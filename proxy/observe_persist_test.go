package proxy

import (
	"path/filepath"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestObserveLoadFromDBRebuildsCounters(t *testing.T) {
	dir := tempDataDir(t)
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	//! One frozen minute for the live records, the snapshots and the warm-up.
	now := time.Now()
	pinObserveClock(t, now)

	live := getObserveStore()
	live.RecordFailure("acc-a", "claude-opus")
	live.RecordError("acc-a", "a@x", "claude-opus", 500, "boom")
	live.RecordTracedRequestWithCache(nil, "acc-b", "", "", "b@x", "claude-opus", 300, 40, 0.5, true, 200, "", cacheTokenCounts{Read: 200, Write: 30})
	live.RecordRequest("acc-a", "a@x", "claude-sonnet", 0, 0, 0, false, 502, "upstream failed")
	live.RecordRequest("", "", "", 0, 0, 0, false, 401, "no key")
	live.RecordRequest("", "", "x-made-up-model", 0, 0, 0, false, 404, "unknown model")
	if mix := live.ModelMix(); len(mix) != 2 {
		t.Fatalf("live model mix counted a rejected request's model: %+v", mix)
	}

	// A request from two days ago: outside the rings, still in the model mix.
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	old := now.Add(-48 * time.Hour).Unix()
	if _, err := d.Exec(`INSERT INTO requests (ts, account_id, model, in_tokens, out_tokens, total_tokens, credits, success) VALUES (?, 'acc-old', 'claude-sonnet', 7, 3, 10, 0.25, 1)`, old); err != nil {
		t.Fatal(err)
	}
	wantOverview := live.Overview()
	wantHeatmap := live.Heatmap(60)

	// A restart: a fresh store warmed only from SQLite, twice to prove it is idempotent.
	resetObservePersistenceForTest(t)
	warm := getObserveStore()
	for i := 0; i < 2; i++ {
		if err := warm.LoadFromDB(); err != nil {
			t.Fatalf("LoadFromDB: %v", err)
		}
	}

	got := warm.Overview()
	if got.RPM1 != wantOverview.RPM1 || got.Successes60 != 1 || got.Errors60 != 3 || got.Retries60 != 1 {
		t.Fatalf("warm overview rpm1 %d ok %d err %d retries %d; live rpm1 %d", got.RPM1, got.Successes60, got.Errors60, got.Retries60, wantOverview.RPM1)
	}
	if got.Credits60 != wantOverview.Credits60 || got.Series.InTPM[observeSeriesMin-1] != 300 {
		t.Fatalf("warm credits %v in %d, live credits %v", got.Credits60, got.Series.InTPM[observeSeriesMin-1], wantOverview.Credits60)
	}

	hm := warm.Heatmap(60)
	if len(hm.Accounts) != len(wantHeatmap.Accounts) || len(hm.Accounts) != 2 {
		t.Fatalf("warm heatmap accounts = %+v, live = %+v", hm.Accounts, wantHeatmap.Accounts)
	}
	for i, row := range hm.Accounts {
		if row.Cells[0] != wantHeatmap.Accounts[i].Cells[0] {
			t.Fatalf("%s current cell = %+v, live %+v", row.AccountID, row.Cells[0], wantHeatmap.Accounts[i].Cells[0])
		}
	}
	slot, _ := curSlot(now.Unix())
	if b := warm.accountRings["acc-b"][slot]; b.CacheReadTokens != 200 || b.CacheWriteTokens != 30 {
		t.Fatalf("acc-b cache tokens = %+v", b)
	}

	mix := map[string]ModelMixEntry{}
	for _, m := range warm.ModelMix() {
		mix[m.Model] = m
	}
	if opus := mix["claude-opus"]; opus.Reqs != 1 || opus.Retries != 1 || opus.InTokens != 300 || opus.CacheReadTokens != 200 {
		t.Fatalf("claude-opus = %+v", opus)
	}
	if sonnet := mix["claude-sonnet"]; sonnet.Reqs != 2 || sonnet.Credits != 0.25 || sonnet.LastUsed == 0 {
		t.Fatalf("claude-sonnet = %+v", sonnet)
	}
	if len(mix) != 2 {
		t.Fatalf("model mix = %+v", mix)
	}
	if reqs := warm.RecentRequests(10); len(reqs) != 5 {
		t.Fatalf("recent requests = %d, want 5", len(reqs))
	}
}

func TestObserveModelWarmupAddsToLiveCounts(t *testing.T) {
	dir := tempDataDir(t)
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	pinObserveClock(t, time.Now())

	s := getObserveStore()
	s.RecordRequest("acc-a", "a@x", "claude-opus", 10, 5, 0.5, true, 200, "")
	warmup, err := s.loadWindowFromDB()
	if err != nil {
		t.Fatalf("loadWindowFromDB: %v", err)
	}
	if mix := s.ModelMix(); len(mix) != 0 {
		t.Fatalf("model mix before the warmup = %+v", mix)
	}
	// Served while the warmup is still pending: counted live, past the warmup's id bound.
	s.RecordRequest("acc-a", "a@x", "claude-opus", 20, 5, 0.25, true, 200, "")
	if err := warmup.run(); err != nil {
		t.Fatalf("warmup: %v", err)
	}
	mix := s.ModelMix()
	if len(mix) != 1 || mix[0].Reqs != 2 || mix[0].InTokens != 30 || mix[0].Credits != 0.75 {
		t.Fatalf("model mix = %+v, want both requests once", mix)
	}

	// A stats reset while a warmup is pending drops it.
	stale, err := s.loadWindowFromDB()
	if err != nil {
		t.Fatalf("loadWindowFromDB: %v", err)
	}
	s.Reset()
	if err := stale.run(); err != nil {
		t.Fatalf("stale warmup: %v", err)
	}
	if mix := s.ModelMix(); len(mix) != 0 {
		t.Fatalf("a warmup older than the reset restored %+v", mix)
	}
}

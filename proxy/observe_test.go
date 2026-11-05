package proxy

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func resetObservePersistenceForTest(t *testing.T) {
	t.Helper()
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	t.Cleanup(func() {
		observeStoreOnce = sync.Once{}
		observeStoreInst = nil
	})
}

// newObserveStoreForTest gives the test a fresh store over a throwaway SQLite
// file, so request logging never touches a real data dir.
func newObserveStoreForTest(t *testing.T) *observeStore {
	t.Helper()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(t.TempDir()); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	return getObserveStore()
}

func TestObserveStore_RecordAndOverview(t *testing.T) {
	s := newObserveStoreForTest(t)

	s.RecordRequest("acc1", "a@b.c", "claude-sonnet-4-6", 100, 50, 0.5, true, 200, "")
	s.RecordRequest("acc1", "a@b.c", "claude-sonnet-4-6", 200, 80, 0.8, true, 200, "")
	s.RecordFailure("acc1", "claude-opus-4-7")
	s.RecordError("acc1", "a@b.c", "claude-opus-4-7", 500, "boom")
	s.RecordRequest("acc1", "a@b.c", "claude-opus-4-7", 0, 0, 0, false, 500, "boom")

	o := s.Overview()
	if o.RPM1 != 3 {
		t.Fatalf("expected RPM1 = 3 client requests, got %d", o.RPM1)
	}
	if o.Successes60 != 2 || o.Errors60 != 1 || o.Retries60 != 1 {
		t.Fatalf("successes/errors/retries = %d/%d/%d, want 2/1/1", o.Successes60, o.Errors60, o.Retries60)
	}
	if o.ActiveAccts != 1 {
		t.Fatalf("expected 1 active account, got %d", o.ActiveAccts)
	}
	if o.TotalModels != 2 {
		t.Fatalf("expected 2 models tracked, got %d", o.TotalModels)
	}
	for name, n := range map[string]int{"rpm": len(o.Series.RPM), "errRate": len(o.Series.ErrRate), "inTpm": len(o.Series.InTPM), "outTpm": len(o.Series.OutTPM), "credits": len(o.Series.Credits)} {
		if n != observeSeriesMin {
			t.Fatalf("series %s has %d points, want %d", name, n, observeSeriesMin)
		}
	}
	last := observeSeriesMin - 1
	if o.Series.RPM[last] != 3 || o.Series.InTPM[last] != 300 || o.Series.OutTPM[last] != 130 {
		t.Fatalf("current minute series = rpm %d in %d out %d", o.Series.RPM[last], o.Series.InTPM[last], o.Series.OutTPM[last])
	}
	if math.Abs(o.Series.ErrRate[last]-1.0/3.0) > 1e-9 || math.Abs(o.Series.Credits[last]-1.3) > 1e-9 {
		t.Fatalf("current minute errRate %v credits %v", o.Series.ErrRate[last], o.Series.Credits[last])
	}
	if o.Series.RPM[0] != 0 {
		t.Fatalf("oldest minute should be empty, got %d", o.Series.RPM[0])
	}
}

func TestObserveStore_CountsEachClientRequestOnce(t *testing.T) {
	s := newObserveStoreForTest(t)

	// Two failed attempts, then the third account answers: one request, two retries.
	s.RecordFailure("acc-a", "m")
	s.RecordFailure("acc-b", "m")
	s.RecordTracedRequestWithCache(nil, "acc-c", "", "", "c@x", "m", 10, 5, 0.2, true, 200, "", cacheTokenCounts{Read: 4})
	// Rejected before any account was picked: global row only.
	s.RecordRequest("", "", "m", 0, 0, 0, false, 401, "no key")

	slot, curMin := curSlot(time.Now().Unix())
	g := s.globalRing[slot]
	if g.WindowMin != curMin || g.Reqs != 2 || g.Successes != 1 || g.Failures != 1 || g.Retries != 2 || g.CacheReadTokens != 4 {
		t.Fatalf("global bucket = %+v", g)
	}
	if b := s.accountRings["acc-c"][slot]; b.Reqs != 1 || b.Successes != 1 || b.Retries != 0 {
		t.Fatalf("acc-c bucket = %+v", b)
	}
	if b := s.accountRings["acc-a"][slot]; b.Reqs != 0 || b.Retries != 1 {
		t.Fatalf("acc-a bucket = %+v", b)
	}
	if _, ok := s.accountRings[""]; ok || len(s.accountRings) != 3 {
		t.Fatalf("empty account id must not get a ring: %v", len(s.accountRings))
	}
	mix := s.ModelMix()
	if len(mix) != 1 || mix[0].Reqs != 2 || mix[0].Retries != 2 || mix[0].Credits != 0.2 {
		t.Fatalf("model mix = %+v", mix)
	}
}

func TestObserveStore_SeqMovesOnEveryChange(t *testing.T) {
	s := newObserveStoreForTest(t)
	seq := s.Seq()
	step := func(name string, fn func()) {
		t.Helper()
		fn()
		if next := s.Seq(); next <= seq {
			t.Fatalf("%s did not move seq (%d -> %d)", name, seq, next)
		} else {
			seq = next
		}
	}
	step("RecordFailure", func() { s.RecordFailure("a", "m") })
	step("RecordError", func() { s.RecordError("a", "e", "m", 500, "x") })
	step("RecordRequest", func() { s.RecordRequest("a", "e", "m", 1, 1, 0, true, 200, "") })
	step("Reset", s.Reset)

	_ = s.Overview()
	_ = s.Heatmap(60)
	_ = s.ModelMix()
	if s.Seq() != seq {
		t.Fatalf("reads moved seq")
	}
}

func TestObserveStore_HeatmapShape(t *testing.T) {
	s := newObserveStoreForTest(t)

	s.RecordRequest("acc1", "", "claude-sonnet-4-6", 10, 10, 0.1, true, 200, "")
	hm := s.Heatmap(30)
	if hm.WindowMin != 30 || hm.BucketMin != 1 {
		t.Fatalf("WindowMin = %d BucketMin = %d", hm.WindowMin, hm.BucketMin)
	}
	if len(hm.Global.Cells) != 30 {
		t.Fatalf("global cells len = %d", len(hm.Global.Cells))
	}
	if len(hm.Accounts) != 1 || hm.RestCount != nil {
		t.Fatalf("accounts len = %d restCount = %v", len(hm.Accounts), hm.RestCount)
	}
	if hm.Global.Cells[0].Reqs != 1 {
		t.Fatalf("expected current minute reqs = 1, got %d", hm.Global.Cells[0].Reqs)
	}
}

// seedMinute writes one minute of traffic straight into a ring, minutesAgo back.
func seedMinute(s *observeStore, accountID string, minutesAgo int, b minuteBucket) {
	slot, curMin := curSlot(time.Now().Unix())
	idx := (slot - minutesAgo + observeMinuteSlots) % observeMinuteSlots
	b.WindowMin = curMin - int64(minutesAgo)
	s.mu.Lock()
	defer s.mu.Unlock()
	addMinute(touchBucket(&s.globalRing, idx, b.WindowMin), b)
	if ring := s.getOrCreateAccountRing(accountID); ring != nil {
		ring[idx] = b
	}
}

func TestObserveStore_HeatmapOptions(t *testing.T) {
	s := newObserveStoreForTest(t)
	seedMinute(s, "busy", 0, minuteBucket{Reqs: 9, Successes: 8, Failures: 1})
	seedMinute(s, "busy", 7, minuteBucket{Reqs: 3, Successes: 3, Credits: 0.5})
	seedMinute(s, "mid", 2, minuteBucket{Reqs: 4, Successes: 4})
	seedMinute(s, "retry-only", 1, minuteBucket{Retries: 2})
	seedMinute(s, "old", 90, minuteBucket{Reqs: 50, Successes: 50})
	seedMinute(s, "idle", 0, minuteBucket{})

	t.Run("global scope", func(t *testing.T) {
		hm := s.HeatmapWith(HeatmapOptions{WindowMin: 60, GlobalOnly: true})
		if hm.Accounts != nil || hm.RestCount != nil || len(hm.Global.Cells) != 60 {
			t.Fatalf("accounts %v rest %v cells %d", hm.Accounts, hm.RestCount, len(hm.Global.Cells))
		}
	})

	t.Run("top ranks the last hour and counts the rest", func(t *testing.T) {
		hm := s.HeatmapWith(HeatmapOptions{WindowMin: 120, Top: 2})
		if len(hm.Accounts) != 2 || hm.Accounts[0].AccountID != "busy" || hm.Accounts[1].AccountID != "mid" {
			t.Fatalf("top rows = %+v", hm.Accounts)
		}
		// retry-only is busy and left out; old (90 min ago) and idle are not ranked.
		if hm.RestCount == nil || *hm.RestCount != 1 {
			t.Fatalf("restCount = %v", hm.RestCount)
		}
	})

	t.Run("sparse keeps offsets", func(t *testing.T) {
		hm := s.HeatmapWith(HeatmapOptions{WindowMin: 60, Sparse: true})
		var offsets []int
		for _, c := range hm.Global.Cells {
			offsets = append(offsets, c.Offset)
		}
		if want := []int{0, 1, 2, 7}; !equalInts(offsets, want) {
			t.Fatalf("global sparse offsets = %v, want %v", offsets, want)
		}
		for _, row := range hm.Accounts {
			if row.AccountID == "idle" && len(row.Cells) != 0 {
				t.Fatalf("idle row should have no cells, got %+v", row.Cells)
			}
			if row.AccountID == "retry-only" && (len(row.Cells) != 1 || row.Cells[0].Retries != 2) {
				t.Fatalf("retry-only row = %+v", row.Cells)
			}
		}
	})

	t.Run("buckets sum minutes", func(t *testing.T) {
		hm := s.HeatmapWith(HeatmapOptions{WindowMin: 60, BucketMin: 5, GlobalOnly: true})
		if hm.BucketMin != 5 || len(hm.Global.Cells) != 12 {
			t.Fatalf("bucketMin %d cells %d", hm.BucketMin, len(hm.Global.Cells))
		}
		first, second := hm.Global.Cells[0], hm.Global.Cells[1]
		if first.Reqs != 13 || first.Failures != 1 || first.Retries != 2 {
			t.Fatalf("bucket 0 = %+v", first)
		}
		if second.Offset != 1 || second.Reqs != 3 || second.Credits != 0.5 {
			t.Fatalf("bucket 1 = %+v", second)
		}
	})
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestObserveStore_PruneAccountRings(t *testing.T) {
	s := newObserveStoreForTest(t)
	s.RecordFailure("kept", "m")
	s.RecordFailure("deleted", "m")
	seq := s.Seq()

	if removed := s.pruneAccountRings([]config.Account{{ID: "kept"}}); removed != 1 {
		t.Fatalf("removed = %d", removed)
	}
	if _, ok := s.accountRings["deleted"]; ok {
		t.Fatalf("deleted account ring survived")
	}
	if _, ok := s.accountRings["kept"]; !ok {
		t.Fatalf("configured account ring was pruned")
	}
	if s.Seq() == seq {
		t.Fatalf("a prune that removed rings must move seq")
	}
	seq = s.Seq()
	s.pruneAccountRings([]config.Account{{ID: "kept"}})
	if s.Seq() != seq {
		t.Fatalf("a prune that removed nothing moved seq")
	}
}

func TestObserveAccountAvailability(t *testing.T) {
	accounts := []config.Account{
		{ID: "ok", Enabled: true},
		{ID: "disabled", Enabled: false},
		{ID: "banned", Enabled: true, BanStatus: "DISABLED"},
		{ID: "active-ban-status", Enabled: true, BanStatus: "ACTIVE"},
		{ID: "suspended", Enabled: true, Silent: true},
		{ID: "over", Enabled: true, UsageCurrent: 50, UsageLimit: 50},
		{ID: "over-overage", Enabled: true, UsageCurrent: 50, UsageLimit: 50, OverageStatus: "ENABLED"},
	}
	if enabled, available := accountAvailability(accounts, false); enabled != 6 || available != 3 {
		t.Fatalf("enabled %d available %d, want 6 and 3", enabled, available)
	}
	if _, available := accountAvailability(accounts, true); available != 4 {
		t.Fatalf("allowOverUsage available %d, want 4", available)
	}
}

func TestObserveTickPublishesOnlyOnChange(t *testing.T) {
	s := newObserveStoreForTest(t)
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)
	h := &Handler{stopStatsSaver: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		h.backgroundObserveTick()
		close(done)
	}()
	defer func() {
		close(h.stopStatsSaver)
		<-done
	}()

	nextTick := func(wait time.Duration) (Event, bool) {
		deadline := time.After(wait)
		for {
			select {
			case evt := <-ch:
				if evt.Type == "observe_tick" {
					return evt, true
				}
			case <-deadline:
				return Event{}, false
			}
		}
	}
	if evt, ok := nextTick(1500 * time.Millisecond); ok {
		t.Fatalf("idle store sent %+v", evt)
	}
	s.RecordFailure("a", "m")
	evt, ok := nextTick(2500 * time.Millisecond)
	if !ok {
		t.Fatalf("no observe_tick after a change")
	}
	if want := strconv.FormatUint(s.Seq(), 10); evt.Payload != want {
		t.Fatalf("payload = %q, want seq %s", evt.Payload, want)
	}
	if evt, ok := nextTick(1500 * time.Millisecond); ok {
		t.Fatalf("unchanged store sent %+v", evt)
	}
}

func TestObserveStore_RecentErrorsOrdering(t *testing.T) {
	s := newObserveStoreForTest(t)

	for i := 0; i < 5; i++ {
		s.RecordError("acc", "e@x", "m", 500, "err-"+string(rune('a'+i)))
	}
	got := s.RecentErrors(3)
	if len(got) != 3 {
		t.Fatalf("expected 3 errors, got %d", len(got))
	}

	if got[0].Message != "err-e" {
		t.Fatalf("expected newest first 'err-e', got %q", got[0].Message)
	}
	if got[2].Message != "err-c" {
		t.Fatalf("expected 3rd 'err-c', got %q", got[2].Message)
	}
}

func TestObserveStore_ModelMixSortedByCredits(t *testing.T) {
	s := newObserveStoreForTest(t)

	s.RecordRequest("a", "", "low", 10, 10, 0.1, true, 200, "")
	s.RecordRequest("a", "", "high", 10, 10, 5.0, true, 200, "")
	s.RecordRequest("a", "", "mid", 10, 10, 1.0, true, 200, "")

	mix := s.ModelMix()
	if len(mix) != 3 {
		t.Fatalf("expected 3 models, got %d", len(mix))
	}
	if mix[0].Model != "high" || mix[2].Model != "low" {
		t.Fatalf("unexpected order: %v", mix)
	}
}

func TestObserveStore_RequestPagePersistsAndFilters(t *testing.T) {
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}

	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	s := getObserveStore()
	defer s.Reset()

	s.RecordRequest("acc-ok", "ok@example.com", "claude-sonnet", 10, 20, 0.03, true, 200, "")
	s.RecordRequest("acc-fail", "fail@example.com", "claude-opus", 0, 0, 0, false, 429, "rate limit exceeded")
	s.RecordRequest("acc-percent", "percent@example.com", "literal%model", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("acc-wild", "wild@example.com", "literalXmodel", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("b-id", "same@example.com", "sort-model", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("a-id", "same@example.com", "sort-model", 1, 1, 0.01, true, 200, "")
	keyA := "sk-client-" + strings.Repeat("a", 50) + "middle-a" + strings.Repeat("z", 50)
	keyB := "sk-client-" + strings.Repeat("b", 50) + "middle-b" + strings.Repeat("y", 50)
	s.RecordRequestWithAPIKey("api-acc-a", "key-a", keyA, "api@example.com", "api-model", 1, 1, 0.01, true, 200, "")
	s.RecordRequestWithAPIKey("api-acc-b", "key-b", keyB, "api@example.com", "api-model", 1, 1, 0.01, true, 200, "")

	page := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "rate", Status: "failed", Sort: "time", Order: "desc"})
	if !page.Persistent {
		t.Fatalf("expected sqlite-backed request page")
	}
	if page.Total != 1 || len(page.Requests) != 1 {
		t.Fatalf("expected 1 filtered request, total=%d len=%d", page.Total, len(page.Requests))
	}
	if page.Requests[0].Message != "rate limit exceeded" || page.Requests[0].Status != 429 {
		t.Fatalf("unexpected persisted error request: %#v", page.Requests[0])
	}

	literalPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "literal%", Sort: "time", Order: "desc"})
	if literalPage.Total != 1 || literalPage.Requests[0].Model != "literal%model" {
		t.Fatalf("expected LIKE wildcard to be escaped, got total=%d rows=%#v", literalPage.Total, literalPage.Requests)
	}

	accountPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "same@example.com", Sort: "account", Order: "asc"})
	if accountPage.Total != 2 || accountPage.Requests[0].AccountID != "a-id" {
		t.Fatalf("expected account sort to use email+accountID, got total=%d rows=%#v", accountPage.Total, accountPage.Requests)
	}

	apiKeyPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "sk-client", Sort: "api_key", Order: "asc"})
	if apiKeyPage.Total != 2 || apiKeyPage.Requests[0].APIKeyID != "key-a" || apiKeyPage.Requests[0].APIKeyMasked == "" {
		t.Fatalf("expected API key search/sort with masked value, got total=%d rows=%#v", apiKeyPage.Total, apiKeyPage.Requests)
	}
	hiddenPartPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "middle-a", Sort: "api_key", Order: "asc"})
	if hiddenPartPage.Total != 1 || hiddenPartPage.Requests[0].APIKeyID != "key-a" {
		t.Fatalf("expected full API key value to be searchable, got total=%d rows=%#v", hiddenPartPage.Total, hiddenPartPage.Requests)
	}
	body, err := json.Marshal(hiddenPartPage.Requests[0])
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if strings.Contains(string(body), keyA) || strings.Contains(string(body), "middle-a") {
		t.Fatalf("request JSON exposed raw API key: %s", string(body))
	}
}

func TestQueryPersistedRequestStats(t *testing.T) {
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	s := getObserveStore()
	defer s.Reset()
	s.RecordRequest("acc-ok-1", "ok1@example.com", "claude-sonnet", 10, 20, 0.30, true, 200, "")
	s.RecordRequest("acc-fail", "fail@example.com", "claude-opus", 0, 0, 0, false, 500, "boom")
	s.RecordRequest("acc-ok-2", "ok2@example.com", "claude-haiku", 3, 7, 0.20, true, 200, "")
	s.RecordError("acc-fail", "fail@example.com", "claude-opus", 500, "boom")

	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatalf("query stats: %v", err)
	}
	if stats.TotalRequests != 3 || stats.SuccessRequests != 2 || stats.FailedRequests != 1 {
		t.Fatalf("unexpected counts: %#v", stats)
	}
	if stats.TotalTokens != 40 {
		t.Fatalf("expected 40 tokens, got %d", stats.TotalTokens)
	}
	if math.Abs(stats.TotalCredits-0.50) > 0.000001 {
		t.Fatalf("expected 0.50 credits, got %.2f", stats.TotalCredits)
	}
	if stats.SuccessTokens != 40 {
		t.Fatalf("expected 40 success tokens, got %d", stats.SuccessTokens)
	}
	if stats.SuccessInTokens != 13 {
		t.Fatalf("expected 13 success input tokens, got %d", stats.SuccessInTokens)
	}
	if stats.SuccessOutTokens != 27 {
		t.Fatalf("expected 27 success output tokens, got %d", stats.SuccessOutTokens)
	}
	if math.Abs(stats.SuccessCredits-0.50) > 0.000001 {
		t.Fatalf("expected 0.50 success credits, got %.2f", stats.SuccessCredits)
	}
	if stats.TotalErrorEvents != 1 {
		t.Fatalf("expected 1 error event, got %d", stats.TotalErrorEvents)
	}
}

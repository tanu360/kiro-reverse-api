package pool

import (
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
)

// setRPMLimitForTest gives the test a fresh config with the per-account limit
// set to n and the RPM clock pinned to the returned pointer's time.
func setRPMLimitForTest(t *testing.T, n int) *time.Time {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.UpdateAccountRPMLimit(n); err != nil {
		t.Fatalf("set limit %d: %v", n, err)
	}
	now := time.Unix(1_800_000_000, 0)
	old := rpmNow
	rpmNow = func() time.Time { return now }
	t.Cleanup(func() { rpmNow = old })
	return &now
}

func pickIDs(p *AccountPool, n int) []string {
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		acc := p.GetNext()
		if acc == nil {
			ids = append(ids, "")
			continue
		}
		ids = append(ids, acc.ID)
	}
	return ids
}

func TestRPMLimitOffByDefault(t *testing.T) {
	setRPMLimitForTest(t, 0)
	p := newTestPool(config.Account{ID: "a"})
	for i, id := range pickIDs(p, 50) {
		if id != "a" {
			t.Fatalf("pick %d = %q with the limit off, want a", i, id)
		}
	}
	if len(p.rpm.m) != 0 {
		t.Fatalf("starts recorded while the limit is off: %v", p.rpm.m)
	}
	if p.BlockedByRPMLimit("") || len(p.AtRPMLimit()) != 0 {
		t.Fatal("the limit reports a block while it is off")
	}
}

func TestRPMLimitSkipsAccountAtLimit(t *testing.T) {
	setRPMLimitForTest(t, 2)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})

	got := pickIDs(p, 5)
	count := map[string]int{}
	for _, id := range got[:4] {
		count[id]++
	}
	if count["a"] != 2 || count["b"] != 2 {
		t.Fatalf("first four picks = %v, want two each of a and b", got[:4])
	}
	if got[4] != "" {
		t.Fatalf("fifth pick = %q, want none: both accounts started 2 requests this minute", got[4])
	}
	if !p.BlockedByRPMLimit("") {
		t.Fatal("BlockedByRPMLimit = false, want true when every account is at the limit")
	}
	if at := p.AtRPMLimit(); !at["a"] || !at["b"] {
		t.Fatalf("AtRPMLimit = %v, want a and b", at)
	}
}

// Priority mode sends every request to the first account until it reaches the
// limit, then to the next priority for the rest of the minute.
func TestRPMLimitAppliesInPriorityMode(t *testing.T) {
	now := setRPMLimitForTest(t, 2)
	if err := config.UpdateRoutingMode(config.RoutingModePriority); err != nil {
		t.Fatalf("UpdateRoutingMode: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateRoutingMode(config.RoutingModeWeighted) })
	p := newTestPool(config.Account{ID: "a", Priority: 0}, config.Account{ID: "b", Priority: 1})

	got := pickIDs(p, 5)
	want := []string{"a", "a", "b", "b", ""}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("picks = %v, want %v", got, want)
		}
	}
	if !p.BlockedByRPMLimit("") {
		t.Fatal("BlockedByRPMLimit = false, want true when every account is at the limit")
	}
	*now = now.Add(time.Minute)
	if acc := p.GetNext(); acc == nil || acc.ID != "a" {
		t.Fatalf("pick a minute later = %v, want a back first", acc)
	}
}

func TestRPMLimitWindowSlides(t *testing.T) {
	now := setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"})

	if acc := p.GetNext(); acc == nil {
		t.Fatal("first pick = nil")
	}
	*now = now.Add(30 * time.Second)
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("pick 30 s later = %s, want none", acc.ID)
	}
	*now = now.Add(29 * time.Second)
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("pick 59 s later = %s, want none", acc.ID)
	}
	*now = now.Add(time.Second)
	if acc := p.GetNext(); acc == nil {
		t.Fatal("pick 60 s later = nil, want a: the window is the last 60 s, the first start left it")
	}
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("second pick 60 s later = %s, want none: the new start fills the window again", acc.ID)
	}
}

func TestRPMLimitLoweredAppliesAtOnce(t *testing.T) {
	now := setRPMLimitForTest(t, 5)
	p := newTestPool(config.Account{ID: "a"})
	for i := 0; i < 3; i++ {
		if acc := p.GetNext(); acc == nil {
			t.Fatalf("pick %d = nil under limit 5", i)
		}
		*now = now.Add(time.Second)
	}
	if err := config.UpdateAccountRPMLimit(2); err != nil {
		t.Fatalf("lower limit: %v", err)
	}
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("pick after lowering to 2 = %s, want none: 3 starts in the window", acc.ID)
	}
	if err := config.UpdateAccountRPMLimit(10); err != nil {
		t.Fatalf("raise limit: %v", err)
	}
	if acc := p.GetNext(); acc == nil {
		t.Fatal("pick after raising to 10 = nil, want a")
	}
}

func TestRPMLimitTurnedOffForgetsStarts(t *testing.T) {
	setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"})
	p.GetNext()
	if err := config.UpdateAccountRPMLimit(0); err != nil {
		t.Fatalf("turn off: %v", err)
	}
	if acc := p.GetNext(); acc == nil {
		t.Fatal("pick with the limit off = nil")
	}
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatalf("turn on: %v", err)
	}
	if acc := p.GetNext(); acc == nil {
		t.Fatal("first pick after turning the limit back on = nil, want a")
	}
}

func TestRPMLimitPreferredMovesWhenAtLimit(t *testing.T) {
	setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})

	if acc := p.GetPreferredForModelExcluding("b", "", nil); acc == nil || acc.ID != "b" {
		t.Fatalf("first preferred pick = %v, want b", acc)
	}
	acc := p.GetPreferredForModelExcluding("b", "", nil)
	if acc == nil || acc.ID != "a" {
		t.Fatalf("preferred pick with b at its limit = %v, want a", acc)
	}
	if acc := p.GetPreferredForModelExcluding("b", "", nil); acc != nil {
		t.Fatalf("third pick = %s, want none", acc.ID)
	}
}

func TestRPMLimitWeightedAccountSharesOneBudget(t *testing.T) {
	setRPMLimitForTest(t, 2)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "a"}, config.Account{ID: "a"})
	got := pickIDs(p, 3)
	if got[0] != "a" || got[1] != "a" || got[2] != "" {
		t.Fatalf("picks of a weight-3 account under limit 2 = %v, want a, a, none", got)
	}
}

func TestBlockedByRPMLimitOnlyWhenRPMIsTheReason(t *testing.T) {
	setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"})
	p.GetNext()
	p.cooldowns["a"] = time.Now().Add(time.Hour)
	if p.GetNext() != nil {
		t.Fatal("pick = account, want none")
	}
	if p.BlockedByRPMLimit("") {
		t.Fatal("BlockedByRPMLimit = true for an account that is also cooling down")
	}

	q := newTestPool(config.Account{ID: "b"})
	q.SetModelList("b", []string{"claude-sonnet-4.5"})
	q.GetNext()
	if q.BlockedByRPMLimit("claude-haiku-4.5") {
		t.Fatal("BlockedByRPMLimit = true for a model the limited account does not serve")
	}
	if !q.BlockedByRPMLimit("claude-sonnet-4.5") {
		t.Fatal("BlockedByRPMLimit = false for the model the limited account serves")
	}
}

func TestBlockedByRPMLimitAllowedCountsOnlyTheKeysAccounts(t *testing.T) {
	setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
	p.GetNextForModelAllowed("", nil, map[string]bool{"a": true})
	p.cooldowns["b"] = time.Now().Add(time.Hour)
	if !p.BlockedByRPMLimitAllowed("", nil) {
		t.Fatal("unbound: BlockedByRPMLimitAllowed = false, want true (a is at the limit)")
	}
	if p.BlockedByRPMLimitAllowed("", map[string]bool{"b": true}) {
		t.Fatal("key bound to b: BlockedByRPMLimitAllowed = true, want false (b cools down, a is not its account)")
	}
	if !p.BlockedByRPMLimitAllowed("", map[string]bool{"a": true}) {
		t.Fatal("key bound to a: BlockedByRPMLimitAllowed = false, want true")
	}
}

func TestRPMLimitConcurrentPicksNeverExceed(t *testing.T) {
	const limit = 7
	setRPMLimitForTest(t, limit)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})

	var served atomic.Int64
	var mu sync.Mutex
	perAccount := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			acc := p.GetNextForModelExcluding("", nil)
			if acc == nil {
				return
			}
			served.Add(1)
			mu.Lock()
			perAccount[acc.ID]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if got := served.Load(); got != 3*limit {
		t.Fatalf("served %d of 64 parallel picks, want exactly %d", got, 3*limit)
	}
	for id, n := range perAccount {
		if n != limit {
			t.Fatalf("account %s started %d requests, want %d", id, n, limit)
		}
	}
}

func TestReleaseRPMStartGivesBackOnlyARecentStart(t *testing.T) {
	now := setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "a"})
	before := *now
	if p.GetNext() == nil {
		t.Fatal("first pick = none")
	}
	if p.GetNext() != nil {
		t.Fatal("second pick = account, want none at a limit of 1")
	}
	p.ReleaseRPMStart("a", before)
	if p.GetNext() == nil {
		t.Fatal("pick after the start was given back = none")
	}
	// A start taken before since is never given back.
	p.ReleaseRPMStart("a", before.Add(time.Second))
	if p.GetNext() != nil {
		t.Fatal("an older start was given back")
	}
}

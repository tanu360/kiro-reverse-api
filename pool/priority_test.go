package pool

import (
	"path/filepath"
	"testing"
	"time"

	"kiro-proxy/config"
)

// useRoutingMode starts a fresh config in mode and puts the mode back to
// weighted afterwards, so later tests that build a pool by hand rotate again.
func useRoutingMode(t *testing.T, mode string) {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.UpdateRoutingMode(mode); err != nil {
		t.Fatalf("UpdateRoutingMode(%q): %v", mode, err)
	}
	t.Cleanup(func() {
		if err := config.UpdateRoutingMode(config.RoutingModeWeighted); err != nil {
			t.Errorf("reset routing mode: %v", err)
		}
	})
}

// picks returns the IDs of n consecutive GetNextForModelExcluding picks, "" for nil.
func picks(p *AccountPool, n int, model string, excluded map[string]bool) []string {
	ids := make([]string, n)
	for i := range ids {
		if acc := p.GetNextForModelExcluding(model, excluded); acc != nil {
			ids[i] = acc.ID
		}
	}
	return ids
}

func wantAll(t *testing.T, got []string, want string) {
	t.Helper()
	for i, id := range got {
		if id != want {
			t.Fatalf("pick %d = %q, want %q every time (all picks: %v)", i, id, want, got)
		}
	}
}

func TestPriorityModePicksLowestPriorityFirst(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	wantAll(t, picks(p, 5, "", nil), "b")
	if acc := p.GetNext(); acc == nil || acc.ID != "b" {
		t.Fatalf("GetNext = %v, want b", acc)
	}
}

func TestPriorityModeTiesKeepListOrder(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 1},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 0},
	)
	wantAll(t, picks(p, 5, "", nil), "b")

	// Every account left at the default 0: the list order decides, so the first one always wins.
	p = newTestPool(config.Account{ID: "x"}, config.Account{ID: "y"}, config.Account{ID: "z"})
	wantAll(t, picks(p, 5, "", nil), "x")
}

func TestPriorityModeFallsThroughCooldown(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	p.cooldowns["b"] = time.Now().Add(time.Minute)
	wantAll(t, picks(p, 3, "", nil), "c")

	p.cooldowns["c"] = time.Now().Add(time.Minute)
	wantAll(t, picks(p, 3, "", nil), "a")

	// The top account takes new requests again as soon as its cooldown ends.
	p.RecordSuccess("b")
	wantAll(t, picks(p, 3, "", nil), "b")
}

func TestPriorityModeFallsThroughExcluded(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	// A retry within one request excludes the accounts that already failed it.
	wantAll(t, picks(p, 3, "m", map[string]bool{"b": true}), "c")
	wantAll(t, picks(p, 3, "m", map[string]bool{"b": true, "c": true}), "a")
}

func TestPriorityModeFallsThroughUnsupportedModel(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	p.SetModelList("b", []string{"claude-haiku-4.5"})
	wantAll(t, picks(p, 3, "claude-opus-4.6", nil), "c")
	wantAll(t, picks(p, 3, "claude-haiku-4.5", nil), "b")
	// No model asked for: every account qualifies.
	wantAll(t, picks(p, 3, "", nil), "b")
}

func TestPriorityModeFallsThroughOverLimitAndUnusableToken(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	expired := time.Now().Add(-time.Hour).Unix()
	p := newTestPool(
		config.Account{ID: "over", Priority: 0, UsageCurrent: 50, UsageLimit: 50},
		config.Account{ID: "stale", Priority: 1, ExpiresAt: expired},
		config.Account{ID: "ok", Priority: 2},
	)
	wantAll(t, picks(p, 3, "", nil), "ok")

	// Upstream overage keeps an over-limit account in its rank, as in weighted mode.
	p = newTestPool(
		config.Account{ID: "over", Priority: 0, UsageCurrent: 50, UsageLimit: 50, OverageStatus: "ENABLED"},
		config.Account{ID: "ok", Priority: 1},
	)
	wantAll(t, picks(p, 3, "", nil), "over")
}

func TestPriorityModeSkipsDisabledAfterReload(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	for _, acc := range []config.Account{
		{ID: "a", Enabled: true, Priority: 0},
		{ID: "b", Enabled: true, Priority: 1},
	} {
		if err := config.AddAccount(acc); err != nil {
			t.Fatalf("add %s: %v", acc.ID, err)
		}
	}
	p := newTestPool()
	p.Reload()
	wantAll(t, picks(p, 3, "", nil), "a")

	if err := config.SetAccountEnabled("a", false); err != nil {
		t.Fatalf("disable a: %v", err)
	}
	p.Reload()
	wantAll(t, picks(p, 3, "", nil), "b")

	// Re-enabled the way the admin switch does it: on, and the DISABLED mark cleared.
	a := config.GetAccounts()[0]
	a.Enabled, a.BanStatus, a.BanTime = true, "ACTIVE", 0
	if err := config.UpdateAccount("a", a); err != nil {
		t.Fatalf("enable a: %v", err)
	}
	p.Reload()
	wantAll(t, picks(p, 3, "", nil), "a")
}

func TestPriorityModeIgnoresWeightDuplicates(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	for _, acc := range []config.Account{
		{ID: "heavy", Enabled: true, Weight: 5, Priority: 1},
		{ID: "light", Enabled: true, Priority: 0},
	} {
		if err := config.AddAccount(acc); err != nil {
			t.Fatalf("add %s: %v", acc.ID, err)
		}
	}
	p := newTestPool()
	p.Reload()
	if len(p.accounts) != 6 {
		t.Fatalf("pool slots = %d, want the heavy account's 5 plus 1", len(p.accounts))
	}
	wantAll(t, picks(p, 6, "", nil), "light")

	p.cooldowns["light"] = time.Now().Add(time.Minute)
	wantAll(t, picks(p, 3, "", nil), "heavy")
}

func TestPriorityModeReturnsNilWhenNoneAvailable(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b", Priority: 1})
	p.cooldowns["a"] = time.Now().Add(time.Minute)
	p.cooldowns["b"] = time.Now().Add(time.Minute)
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("GetNext = %s, want nil with every account cooling down", acc.ID)
	}
	if acc := p.GetPreferredForModelExcluding("a", "", nil); acc != nil {
		t.Fatalf("preferred pick = %s, want nil", acc.ID)
	}
	if acc := newTestPool().GetNext(); acc != nil {
		t.Fatalf("empty pool returned %s", acc.ID)
	}
}

// Session affinity wins over priority: a running conversation stays on its
// account while that account can serve, and only falls to the top account once
// it cannot.
func TestPriorityModeAffinityKeepsBoundAccount(t *testing.T) {
	useRoutingMode(t, config.RoutingModePriority)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	for i := 0; i < 3; i++ {
		if acc := p.GetPreferredForModelExcluding("a", "", nil); acc == nil || acc.ID != "a" {
			t.Fatalf("bound pick %d = %v, want a", i, acc)
		}
	}
	// A new conversation (no binding) still goes to the top account.
	if acc := p.GetPreferredForModelExcluding("", "", nil); acc == nil || acc.ID != "b" {
		t.Fatalf("unbound pick = %v, want b", acc)
	}

	p.cooldowns["a"] = time.Now().Add(time.Minute)
	if acc := p.GetPreferredForModelExcluding("a", "", nil); acc == nil || acc.ID != "b" {
		t.Fatalf("pick with the bound account cooling down = %v, want b", acc)
	}
	if acc := p.GetPreferredForModelExcluding("a", "", map[string]bool{"b": true}); acc == nil || acc.ID != "c" {
		t.Fatalf("pick with a cooling and b excluded = %v, want c", acc)
	}
}

func TestPriorityModeLeavesRotationCursorAlone(t *testing.T) {
	useRoutingMode(t, config.RoutingModeWeighted)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 1},
		config.Account{ID: "c", Priority: 0},
	)
	if acc := p.GetNext(); acc.ID != "a" {
		t.Fatalf("first weighted pick = %s, want a", acc.ID)
	}

	if err := config.UpdateRoutingMode(config.RoutingModePriority); err != nil {
		t.Fatal(err)
	}
	wantAll(t, picks(p, 4, "", nil), "c")

	if err := config.UpdateRoutingMode(config.RoutingModeWeighted); err != nil {
		t.Fatal(err)
	}
	if acc := p.GetNext(); acc.ID != "b" {
		t.Fatalf("weighted pick after priority picks = %s, want b (rotation resumes)", acc.ID)
	}
}

func TestWeightedModeIgnoresPriority(t *testing.T) {
	useRoutingMode(t, config.RoutingModeWeighted)
	p := newTestPool(
		config.Account{ID: "a", Priority: 2},
		config.Account{ID: "b", Priority: 0},
		config.Account{ID: "c", Priority: 1},
	)
	got := picks(p, 6, "", nil)
	want := []string{"a", "b", "c", "a", "b", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("weighted rotation = %v, want %v", got, want)
		}
	}
}

func TestRoutingModeSwitchAppliesWithoutReload(t *testing.T) {
	useRoutingMode(t, config.RoutingModeWeighted)
	p := newTestPool(
		config.Account{ID: "a", Priority: 1},
		config.Account{ID: "b", Priority: 0},
	)
	if acc := p.GetNext(); acc.ID != "a" {
		t.Fatalf("weighted pick = %s, want a", acc.ID)
	}
	if err := config.UpdateRoutingMode(config.RoutingModePriority); err != nil {
		t.Fatal(err)
	}
	wantAll(t, picks(p, 3, "", nil), "b")
}

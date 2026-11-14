package pool

import (
	"testing"
	"time"

	"kiro-proxy/config"
)

// inDays is the reset date n days from today, as NextResetDate holds it.
func inDays(n int) string {
	return time.Now().AddDate(0, 0, n).Format(resetDateLayout)
}

// resetAccount is an account with used of limit credits spent and its credits
// resetting in days days.
func resetAccount(id string, days int, used, limit float64) config.Account {
	return config.Account{ID: id, NextResetDate: inDays(days), UsageCurrent: used, UsageLimit: limit}
}

func TestResetFirstPicksTheSoonestReset(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		resetAccount("late", 20, 0, 500),
		resetAccount("soon", 3, 400, 500),
		resetAccount("mid", 9, 0, 500),
	)
	wantAll(t, picks(p, 4, "", nil), "soon")
}

func TestResetFirstTieGoesToMoreCreditsLeft(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		resetAccount("less", 5, 300, 500),
		resetAccount("more", 5, 100, 500),
		resetAccount("later", 6, 0, 500),
	)
	wantAll(t, picks(p, 3, "", nil), "more")

	// Same day and same credits left: the account-list order decides.
	p = newTestPool(resetAccount("first", 5, 100, 500), resetAccount("second", 5, 100, 500))
	wantAll(t, picks(p, 3, "", nil), "first")
}

func TestResetFirstSkipsAccountsWithoutCredits(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	empty := resetAccount("empty", 1, 500, 500)
	p := newTestPool(empty, resetAccount("full", 10, 0, 500))
	wantAll(t, picks(p, 3, "", nil), "full")

	// With over-usage allowed the empty account can serve, but only after every account with credits.
	if err := config.UpdateAllowOverUsage(true); err != nil {
		t.Fatalf("allow over usage: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateAllowOverUsage(false) })
	wantAll(t, picks(p, 3, "", nil), "full")
	p.cooldowns["full"] = time.Now().Add(time.Minute)
	wantAll(t, picks(p, 2, "", nil), "empty")
}

func TestResetFirstUnknownOrPastResetGoesLast(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		config.Account{ID: "unknown", UsageLimit: 500},
		resetAccount("stale", -2, 0, 500),
		resetAccount("known", 25, 450, 500),
	)
	wantAll(t, picks(p, 3, "", nil), "known")
	// A reset today is not past: it still counts as the soonest.
	p = newTestPool(resetAccount("tomorrow", 1, 0, 500), resetAccount("today", 0, 0, 500))
	wantAll(t, picks(p, 2, "", nil), "today")
}

func TestResetFirstRespectsCooldownExclusionModelAndRPM(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		resetAccount("a", 1, 0, 500),
		resetAccount("b", 2, 0, 500),
		resetAccount("c", 3, 0, 500),
	)
	p.cooldowns["a"] = time.Now().Add(time.Minute)
	if acc := p.GetNextForModelExcluding("", map[string]bool{"b": true}); acc == nil || acc.ID != "c" {
		t.Fatalf("cooldown a, excluded b: picked %v, want c", acc)
	}
	p.SetModelList("b", []string{"claude-haiku-4.5"})
	delete(p.cooldowns, "a")
	p.SetModelList("a", []string{"claude-sonnet-4.5"})
	if acc := p.GetNextForModelExcluding("claude-haiku-4.5", nil); acc == nil || acc.ID != "b" {
		t.Fatalf("model only b lists: picked %v, want b", acc)
	}

	// The RPM limit holds the soonest account back once it used its minute.
	now := setRPMLimitForTest(t, 1)
	if err := config.UpdateRoutingMode(config.RoutingModeResetFirst); err != nil {
		t.Fatal(err)
	}
	p = newTestPool(resetAccount("a", 1, 0, 500), resetAccount("b", 2, 0, 500))
	if got := picks(p, 3, "", nil); got[0] != "a" || got[1] != "b" || got[2] != "" {
		t.Fatalf("RPM 1: picks %v, want [a b \"\"]", got)
	}
	*now = now.Add(61 * time.Second)
	if acc := p.GetNext(); acc == nil || acc.ID != "a" {
		t.Fatalf("after the window: picked %v, want a", acc)
	}
}

func TestResetFirstAffinityKeepsSameDayAndMovesToEarlierReset(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		resetAccount("best", 4, 0, 500),
		resetAccount("bound", 4, 400, 500),
		resetAccount("later", 9, 0, 500),
	)
	// Same reset day as the best account: the conversation stays put for its prompt cache.
	if acc := p.GetPreferredForModelExcluding("bound", "", nil); acc == nil || acc.ID != "bound" {
		t.Fatalf("same-day bound account: picked %v, want bound", acc)
	}
	// A bound account that resets later loses the conversation to one that resets sooner.
	if acc := p.GetPreferredForModelExcluding("later", "", nil); acc == nil || acc.ID != "best" {
		t.Fatalf("later bound account: picked %v, want best", acc)
	}
	// Unless the sooner one cannot serve right now.
	p.cooldowns["best"] = time.Now().Add(time.Minute)
	p.cooldowns["bound"] = time.Now().Add(time.Minute)
	if acc := p.GetPreferredForModelExcluding("later", "", nil); acc == nil || acc.ID != "later" {
		t.Fatalf("sooner accounts cooling down: picked %v, want later", acc)
	}
}

func TestScopeModeOverridesTheGlobalMode(t *testing.T) {
	useRoutingMode(t, config.RoutingModeWeighted)
	p := newTestPool(
		config.Account{ID: "a", Priority: 5, NextResetDate: inDays(9), UsageLimit: 500},
		config.Account{ID: "b", Priority: 0, NextResetDate: inDays(30), UsageLimit: 500},
		config.Account{ID: "c", Priority: 9, NextResetDate: inDays(2), UsageLimit: 500},
	)
	reset := Scope{Mode: config.RoutingModeResetFirst}
	for i := 0; i < 3; i++ {
		if acc := p.GetNextForModelScoped("", nil, reset); acc == nil || acc.ID != "c" {
			t.Fatalf("reset-first key pick %d = %v, want c", i, acc)
		}
	}
	prio := Scope{Mode: config.RoutingModePriority, Allowed: map[string]bool{"a": true, "c": true}}
	if acc := p.GetNextForModelScoped("", nil, prio); acc == nil || acc.ID != "a" {
		t.Fatalf("priority key limited to a and c = %v, want a", acc)
	}
	// The global weighted rotation is untouched by the keys' picks.
	seen := map[string]bool{}
	for _, id := range picks(p, 3, "", nil) {
		seen[id] = true
	}
	if len(seen) != 3 {
		t.Fatalf("weighted picks %v, want every account", seen)
	}
	// An affinity hit keeps a same-priority preferred account under a priority key.
	if acc := p.GetPreferredForModelScoped("c", "", nil, Scope{Mode: config.RoutingModePriority}); acc == nil || acc.ID != "b" {
		t.Fatalf("priority key with c preferred = %v, want b (better priority)", acc)
	}
}

func TestEmptyScopeGetsNoAccount(t *testing.T) {
	useRoutingMode(t, config.RoutingModeWeighted)
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
	none := Scope{Allowed: map[string]bool{}}
	if acc := p.GetNextForModelScoped("", nil, none); acc != nil {
		t.Fatalf("empty scope picked %v, want nil", acc)
	}
	if acc := p.GetPreferredForModelScoped("a", "", nil, none); acc != nil {
		t.Fatalf("empty scope with a preferred picked %v, want nil", acc)
	}
}

func TestResetFirstCountsSpendSinceTheLastRefresh(t *testing.T) {
	useRoutingMode(t, config.RoutingModeResetFirst)
	p := newTestPool(
		config.Account{ID: "a", NextResetDate: inDays(5), UsageCurrent: 100, UsageLimit: 500, LastRefresh: 10},
		config.Account{ID: "b", NextResetDate: inDays(5), UsageCurrent: 150, UsageLimit: 500, LastRefresh: 10},
	)
	wantAll(t, picks(p, 2, "", nil), "a")
	// a spent 80 since its refresh: 320 left against b's 350.
	p.noteSpend("a", 80)
	wantAll(t, picks(p, 2, "", nil), "b")
	if got := p.SpentSinceRefresh("a"); got != 80 {
		t.Fatalf("SpentSinceRefresh(a) = %v, want 80", got)
	}
	// A newer refresh folds the spend into UsageCurrent; the local sum stops counting.
	p.accounts[0].LastRefresh = 20
	if got := p.SpentSinceRefresh("a"); got != 0 {
		t.Fatalf("after a refresh SpentSinceRefresh(a) = %v, want 0", got)
	}
	wantAll(t, picks(p, 2, "", nil), "a")
}

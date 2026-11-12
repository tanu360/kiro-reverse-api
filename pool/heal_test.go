package pool

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestCooldownKindSurvivesSaveLoad(t *testing.T) {
	//! Runs first in this file: the other tests' async cooldown saves must not land between save and load.
	//! ResetForTest also clears a failed open left by a save that ran before any data dir was set.
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "over", Enabled: true, AccessToken: "t"}); err != nil {
		t.Fatal(err)
	}
	p := newTestPool(config.Account{ID: "over", AccessToken: "t"})
	until := time.Now().Add(time.Hour)
	p.mu.Lock()
	for id, kind := range map[string]CooldownKind{"q": CooldownQuota, "e": CooldownError, "th": CooldownThrottle, "ra": CooldownRetryAfter} {
		p.cooldowns[id] = until
		p.setKindLocked(id, kind)
	}
	p.mu.Unlock()
	p.MarkOverLimit("over")
	if err := p.SaveCooldowns(); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded := newTestPool()
	if err := loaded.loadCooldowns(); err != nil {
		t.Fatalf("load: %v", err)
	}
	want := map[string]CooldownKind{"q": CooldownQuota, "e": CooldownError, "th": CooldownThrottle, "ra": CooldownRetryAfter, "over": CooldownQuota}
	for id, kind := range want {
		if got := loaded.CooldownKindOf(id); got != kind {
			t.Errorf("%s loaded kind = %q, want %q", id, got, kind)
		}
	}
}

func TestCooldownKindTracksSource(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "errors", AccessToken: "t"},
		config.Account{ID: "throttle", AccessToken: "t"},
		config.Account{ID: "hinted", AccessToken: "t"},
		config.Account{ID: "quota", AccessToken: "t", NextResetDate: "2099-01-01"},
	)
	for i := 0; i < 2; i++ {
		p.RecordError("errors", false)
	}
	if got := p.CooldownKindOf("errors"); got != "" {
		t.Fatalf("two errors set cooldown kind %q, want none", got)
	}
	p.RecordError("errors", false)
	p.RecordThrottleError("throttle", 0)
	p.RecordThrottleError("hinted", 5*time.Minute)
	p.RecordQuotaError("quota", 0)

	want := map[string]CooldownKind{
		"errors":   CooldownError,
		"throttle": CooldownThrottle,
		"hinted":   CooldownRetryAfter,
		"quota":    CooldownQuota,
	}
	for id, kind := range want {
		if got := p.CooldownKindOf(id); got != kind {
			t.Errorf("%s cooldown kind = %q, want %q", id, got, kind)
		}
	}
	p.RecordSuccess("throttle")
	if got := p.CooldownKindOf("throttle"); got != "" {
		t.Fatalf("a success left cooldown kind %q", got)
	}
}

func TestThrottleKeepsQuotaKindWhenNotGrowing(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "drained", AccessToken: "t"},
		config.Account{ID: "hinted", AccessToken: "t"},
		config.Account{ID: "erroring", AccessToken: "t"},
	)
	p.RecordQuotaError("drained", 0)
	p.RecordThrottleError("drained", 0)
	if got := p.CooldownKindOf("drained"); got != CooldownQuota {
		t.Fatalf("a throttle turned a quota cooldown into %q", got)
	}

	//! A backoff that outgrows an upstream hint must not make the hinted wait healable.
	p.RecordThrottleError("hinted", 30*time.Second)
	p.RecordThrottleError("hinted", 0)
	p.RecordThrottleError("hinted", 0)
	if got := p.CooldownKindOf("hinted"); got != CooldownRetryAfter {
		t.Fatalf("a grown throttle over a retry hint has kind %q, want retry_after", got)
	}

	for i := 0; i < 3; i++ {
		p.RecordError("erroring", false)
	}
	p.RecordThrottleError("erroring", 0)
	if got := p.CooldownKindOf("erroring"); got != CooldownThrottle {
		t.Fatalf("a throttle over an error cooldown has kind %q, want throttle", got)
	}
}

func TestClearTransientKeepsQuotaAndRetryAfter(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "errors", AccessToken: "t"},
		config.Account{ID: "throttle", AccessToken: "t"},
		config.Account{ID: "hinted", AccessToken: "t"},
		config.Account{ID: "quota", AccessToken: "t"},
	)
	for i := 0; i < 3; i++ {
		p.RecordError("errors", false)
	}
	p.RecordThrottleError("throttle", 0)
	p.RecordThrottleError("hinted", 5*time.Minute)
	p.RecordQuotaError("quota", 0)

	cleared := p.ClearTransient([]string{"errors", "throttle", "hinted", "quota", "unknown"})
	slices.Sort(cleared)
	if !slices.Equal(cleared, []string{"errors", "throttle"}) {
		t.Fatalf("cleared = %v, want errors and throttle", cleared)
	}
	for _, id := range []string{"errors", "throttle"} {
		if !p.CooldownUntil(id).IsZero() {
			t.Errorf("%s still cooling after heal", id)
		}
	}
	if p.CooldownKindOf("hinted") != CooldownRetryAfter || p.CooldownKindOf("quota") != CooldownQuota {
		t.Fatal("heal dropped a quota or retry-hint cooldown")
	}
	p.mu.RLock()
	count := p.errorCounts["errors"]
	p.mu.RUnlock()
	if count != 0 {
		t.Fatalf("error count after heal = %d, want 0", count)
	}
	p.RecordError("errors", false)
	if p.CooldownKindOf("errors") != "" {
		t.Fatal("the first error after a heal cooled the account again")
	}
}

func TestClearTransientKeepsThrottleBackoff(t *testing.T) {
	p := newTestPool(config.Account{ID: "storm", AccessToken: "t"})
	for i := 0; i < 4; i++ {
		p.RecordThrottleError("storm", 0)
	}
	if cleared := p.ClearTransient([]string{"storm"}); !slices.Equal(cleared, []string{"storm"}) {
		t.Fatalf("cleared = %v, want storm", cleared)
	}
	if !p.CooldownUntil("storm").IsZero() {
		t.Fatal("the throttle cooldown survived the heal")
	}
	//! The fifth throttle in a row waits the full ten minutes, heal or no heal.
	p.RecordThrottleError("storm", 0)
	if left := time.Until(p.CooldownUntil("storm")); left < 9*time.Minute {
		t.Fatalf("backoff after a heal = %v, want the ladder to keep climbing", left)
	}
}

func TestHealViewReportsServableAndCooled(t *testing.T) {
	now := time.Now()
	p := newTestPool(
		config.Account{ID: "throttled", AccessToken: "t"},
		config.Account{ID: "throttled", AccessToken: "t"},
		config.Account{ID: "quota", AccessToken: "t"},
		config.Account{ID: "dead-token", AccessToken: "t", ExpiresAt: now.Add(-time.Hour).Unix()},
		config.Account{ID: "legacy", AccessToken: "t"},
	)
	p.RecordThrottleError("throttled", 0)
	p.RecordThrottleError("dead-token", 0)
	p.RecordQuotaError("quota", 0)
	p.mu.Lock()
	//! A row loaded from before kinds existed has no kind and stays held.
	p.cooldowns["legacy"] = now.Add(time.Hour)
	p.setKindLocked("legacy", "")
	p.mu.Unlock()

	view := p.HealView(now)
	if view.Servable {
		t.Fatal("no account can serve, yet the view says one can")
	}
	if !slices.Equal(view.Cooled, []string{"throttled"}) {
		t.Fatalf("cooled = %v, want only throttled (once)", view.Cooled)
	}
	if !view.Held["quota"] || !view.Held["legacy"] || view.Held["throttled"] {
		t.Fatalf("held = %v, want quota and legacy", view.Held)
	}

	p.accounts = append(p.accounts, config.Account{ID: "free", AccessToken: "t"})
	if !p.HealView(now).Servable {
		t.Fatal("a free account must make the pool servable")
	}
}

func TestHealCandidateNeedsAUsableToken(t *testing.T) {
	now := time.Now()
	if !HealCandidate(config.Account{ID: "ok", AccessToken: "t"}, now) {
		t.Fatal("an account with a token is a candidate")
	}
	if HealCandidate(config.Account{ID: "dead", ExpiresAt: now.Add(-time.Hour).Unix()}, now) {
		t.Fatal("an expired token with no refresh token cannot serve")
	}
	if !HealCandidate(config.Account{ID: "refreshable", ExpiresAt: now.Add(-time.Hour).Unix(), RefreshToken: "r"}, now) {
		t.Fatal("an expired token that can refresh is a candidate")
	}
}

func TestLiteralPoolSetsKindWithoutPanic(t *testing.T) {
	p := &AccountPool{cooldowns: map[string]time.Time{}, errorCounts: map[string]int{}}
	p.RecordThrottleError("x", 0)
	if p.CooldownKindOf("x") != CooldownThrottle {
		t.Fatal("kind not recorded on a pool built without its kind map")
	}
	if got := (&AccountPool{}).ClearTransient([]string{"x"}); len(got) != 0 {
		t.Fatalf("an empty pool cleared %v", got)
	}
}

func TestRecordSuccessFiresSuccessHook(t *testing.T) {
	var got []string
	SetSuccessHook(func(id string) { got = append(got, id) })
	t.Cleanup(func() { SetSuccessHook(nil) })
	p := newTestPool(config.Account{ID: "a", AccessToken: "t"})
	p.RecordSuccess("a")
	if !slices.Equal(got, []string{"a"}) {
		t.Fatalf("hook calls = %v, want [a]", got)
	}
}

func TestIsSuspensionErrorDetectsLockedAccount(t *testing.T) {
	if !IsSuspensionError(errors.New(`HTTP 403: {"message":"Your account is suspended; we have Locked Your Account"}`)) {
		t.Fatal("a locked-account 403 must read as a suspension")
	}
	if IsSuspensionError(errors.New("HTTP 423: resource locked")) {
		t.Fatal("a locked resource is not a suspended account")
	}
}

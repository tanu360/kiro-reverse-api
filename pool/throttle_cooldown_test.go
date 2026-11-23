package pool

import (
	"kiro-proxy/config"
	"testing"
	"time"
)

func cooldownLeft(t *testing.T, p *AccountPool, id string) time.Duration {
	t.Helper()
	return time.Until(p.CooldownUntil(id))
}

// expireCooldown ends id's cooldown as if its wait ran out, keeping the backoff count, so the
// next throttle is the next rung of the ladder rather than a reply that was already in flight.
func expireCooldown(p *AccountPool, id string) {
	p.mu.Lock()
	p.cooldowns[id] = time.Now().Add(-time.Second)
	p.mu.Unlock()
}

// Kiro's USER_REQUEST_RATE_EXCEEDED clears within a second or two: live on 2026-11-20 the same
// account answered again a second after all three endpoints said 429. A first wait of a minute
// took every model that only one account serves offline for that whole minute.
func TestThrottleCooldownIsShortAndGrowsToCap(t *testing.T) {
	p := newTestPool(config.Account{ID: "busy", Enabled: true, AccessToken: "token", NextResetDate: "2099-01-01"})
	want := []time.Duration{
		5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second,
		160 * time.Second, 320 * time.Second, 10 * time.Minute, 10 * time.Minute,
	}
	for i, expected := range want {
		expireCooldown(p, "busy")
		p.RecordThrottleError("busy", 0)
		if left := cooldownLeft(t, p, "busy"); left > expected || left < expected-2*time.Second {
			t.Fatalf("throttle #%d cooldown = %v, want about %v", i+1, left, expected)
		}
	}
	p.RecordSuccess("busy")
	p.RecordThrottleError("busy", 0)
	if left := cooldownLeft(t, p, "busy"); left > throttleBaseCooldown {
		t.Fatalf("a success must reset the throttle backoff, got %v", left)
	}
}

// Replies already in flight when Kiro starts throttling come back as 429s together. They are
// one throttle, not a run of them, so they must not climb the ladder to its ten-minute cap.
func TestThrottlesInFlightTogetherCountOnce(t *testing.T) {
	p := newTestPool(config.Account{ID: "burst", Enabled: true, AccessToken: "token"})
	for i := 0; i < 6; i++ {
		p.RecordThrottleError("burst", 0)
	}
	if left := cooldownLeft(t, p, "burst"); left > throttleBaseCooldown {
		t.Fatalf("six 429s from one burst cooled the account for %v, want at most %v", left, throttleBaseCooldown)
	}
	expireCooldown(p, "burst")
	p.RecordThrottleError("burst", 0)
	if left := cooldownLeft(t, p, "burst"); left <= throttleBaseCooldown {
		t.Fatalf("a throttle after the wait ran out must climb the ladder, got %v", left)
	}
}

func TestThrottleCooldownHonoursRetryAfter(t *testing.T) {
	p := newTestPool(config.Account{ID: "hinted", Enabled: true, AccessToken: "token"})
	p.RecordThrottleError("hinted", 5*time.Minute)
	if left := cooldownLeft(t, p, "hinted"); left > 5*time.Minute || left < 4*time.Minute {
		t.Fatalf("retry hint ignored: %v", left)
	}
}

func TestThrottleNeverShortensLongerCooldown(t *testing.T) {
	p := newTestPool(config.Account{ID: "drained", Enabled: true, AccessToken: "token"})
	p.RecordQuotaError("drained", 0)
	p.RecordThrottleError("drained", 0)
	if left := cooldownLeft(t, p, "drained"); left < 23*time.Hour {
		t.Fatalf("a throttle shortened a quota cooldown to %v", left)
	}
}

// A request that fails alongside one that hit the quota or got a retry hint ends a third error
// in a row. Its one-minute cooldown must not cut the longer wait short, nor turn it into an
// error cooldown that self-heal may clear.
func TestErrorStreakNeverShortensLongerCooldown(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "drained", Enabled: true, AccessToken: "token"},
		config.Account{ID: "hinted", Enabled: true, AccessToken: "token"},
	)
	p.RecordQuotaError("drained", 0)
	p.RecordThrottleError("hinted", 5*time.Minute)
	for i := 0; i < 3; i++ {
		p.RecordError("drained", false)
		p.RecordError("hinted", false)
	}
	if left := cooldownLeft(t, p, "drained"); left < 23*time.Hour {
		t.Fatalf("an error streak shortened a quota cooldown to %v", left)
	}
	if kind := p.CooldownKindOf("drained"); kind != CooldownQuota {
		t.Fatalf("quota cooldown kind = %q after an error streak, want %q", kind, CooldownQuota)
	}
	if left := cooldownLeft(t, p, "hinted"); left < 4*time.Minute {
		t.Fatalf("an error streak shortened a retry hint to %v", left)
	}
	if kind := p.CooldownKindOf("hinted"); kind != CooldownRetryAfter {
		t.Fatalf("retry hint kind = %q after an error streak, want %q", kind, CooldownRetryAfter)
	}
}

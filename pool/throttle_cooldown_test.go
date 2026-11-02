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

func TestThrottleCooldownIsShortAndGrowsToCap(t *testing.T) {
	p := newTestPool(config.Account{ID: "busy", Enabled: true, AccessToken: "token", NextResetDate: "2099-01-01"})
	want := []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute}
	for i, expected := range want {
		p.RecordThrottleError("busy", 0)
		if left := cooldownLeft(t, p, "busy"); left > expected || left < expected-5*time.Second {
			t.Fatalf("throttle #%d cooldown = %v, want about %v", i+1, left, expected)
		}
	}
	p.RecordSuccess("busy")
	p.RecordThrottleError("busy", 0)
	if left := cooldownLeft(t, p, "busy"); left > time.Minute {
		t.Fatalf("a success must reset the throttle backoff, got %v", left)
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

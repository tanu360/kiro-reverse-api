package pool

import (
	"kiro-proxy/config"
	"testing"
	"time"
)

func TestCoolingAccountStaysUnavailableAcrossRequests(t *testing.T) {
	p := newTestPool(config.Account{ID: "cooling", Enabled: true, AccessToken: "token"})
	p.cooldowns["cooling"] = time.Now().Add(time.Hour)
	for i := 0; i < 3; i++ {
		if got := p.GetNextForModel("claude-sonnet-4.5"); got != nil {
			t.Fatal("active cooldown bypassed")
		}
	}
	p.cooldowns["cooling"] = time.Now().Add(-time.Second)
	if p.GetNext() == nil {
		t.Fatal("expired cooldown still blocks account")
	}
}

func TestQuotaRetryHintDoesNotBecomeDayLongCooldown(t *testing.T) {
	p := newTestPool(config.Account{ID: "throttled", Enabled: true, AccessToken: "token"})
	p.RecordQuotaError("throttled", 2*time.Minute)
	p.mu.RLock()
	until := p.cooldowns["throttled"]
	p.mu.RUnlock()
	if delay := time.Until(until); delay < time.Minute || delay > 3*time.Minute {
		t.Fatalf("retry hint ignored: %v", delay)
	}
	p.RecordQuotaError("throttled", time.Second)
	p.mu.RLock()
	next := p.cooldowns["throttled"]
	p.mu.RUnlock()
	if next.Before(until) {
		t.Fatal("concurrent shorter hint shortened existing cooldown")
	}
}

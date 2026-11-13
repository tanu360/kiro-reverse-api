package pool

import (
	"testing"
	"time"

	"kiro-proxy/config"
)

func TestCooldownRetryAfterIsTheSoonestCooldownEnd(t *testing.T) {
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"}, config.Account{ID: "c"})
	if wait := p.CooldownRetryAfter("", nil); wait != 0 {
		t.Fatalf("no cooldown: wait %v", wait)
	}
	now := time.Now()
	p.cooldowns["a"] = now.Add(50 * time.Second)
	p.cooldowns["b"] = now.Add(20 * time.Second)
	p.cooldowns["c"] = now.Add(-time.Second)
	if wait := p.CooldownRetryAfter("", nil); wait <= 15*time.Second || wait > 20*time.Second {
		t.Fatalf("wait = %v, want about 20s", wait)
	}
	if wait := p.CooldownRetryAfter("", map[string]bool{"a": true}); wait <= 45*time.Second || wait > 50*time.Second {
		t.Fatalf("a key bound to a: wait = %v, want about 50s", wait)
	}
	p.modelLists["b"] = map[string]bool{"other-model": true}
	if wait := p.CooldownRetryAfter("claude-haiku-4.5", nil); wait <= 45*time.Second {
		t.Fatalf("an account without the model does not count: wait = %v", wait)
	}
}

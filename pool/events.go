package pool

import "sync"

var (
	cooldownHookMu sync.RWMutex
	cooldownHook   func(id string)
)

// SetCooldownChangedHook registers fn to run after an account's cooldown
// starts, grows or is cleared by a success. Cooldowns live only in the pool,
// so config's accounts hook never sees them. fn runs outside the pool lock and
// must not block.
func SetCooldownChangedHook(fn func(id string)) {
	cooldownHookMu.Lock()
	cooldownHook = fn
	cooldownHookMu.Unlock()
}

func notifyCooldownChanged(id string) {
	cooldownHookMu.RLock()
	fn := cooldownHook
	cooldownHookMu.RUnlock()
	if fn != nil {
		fn(id)
	}
}

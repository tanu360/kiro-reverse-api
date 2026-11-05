package config

import "sync"

var (
	accountsHookMu sync.RWMutex
	accountsHook   func(id string)
)

// SetAccountsChangedHook registers fn to run after an account row is added,
// changed or removed. The proxy uses it to tell open admin pages to refetch.
// fn runs after the write is saved and must not block.
func SetAccountsChangedHook(fn func(id string)) {
	accountsHookMu.Lock()
	accountsHook = fn
	accountsHookMu.Unlock()
}

func notifyAccountsChanged(id string) {
	accountsHookMu.RLock()
	fn := accountsHook
	accountsHookMu.RUnlock()
	if fn != nil {
		fn(id)
	}
}

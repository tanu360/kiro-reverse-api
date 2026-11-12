package config

import (
	"errors"
	"fmt"
)

// MaxAccountRPMLimit caps the per-account requests-per-minute limit.
const MaxAccountRPMLimit = 1000

// ErrAccountRPMLimitRange rejects a limit below 0 or above MaxAccountRPMLimit.
var ErrAccountRPMLimitRange = errors.New("account rpm limit out of range")

// GetAccountRPMLimit returns how many requests one account may start per
// minute before the pool skips it. 0 means no limit, the default. A stored
// value out of range reads as 0, so a bad config never blocks traffic.
func GetAccountRPMLimit() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.AccountRPMLimit < 0 || cfg.AccountRPMLimit > MaxAccountRPMLimit {
		return 0
	}
	return cfg.AccountRPMLimit
}

// UpdateAccountRPMLimit sets the per-account limit; 0 turns it off.
func UpdateAccountRPMLimit(n int) error {
	if n < 0 || n > MaxAccountRPMLimit {
		return fmt.Errorf("%w: accountRpmLimit must be between 0 and %d", ErrAccountRPMLimitRange, MaxAccountRPMLimit)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.AccountRPMLimit = n
	return Save()
}

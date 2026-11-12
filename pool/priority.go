package pool

import (
	"time"

	"kiro-proxy/config"
)

// firstByPriorityLocked is the priority routing mode's pick: of the accounts
// that can serve model right now (canServeLocked: not excluded, model listed,
// no cooldown, usable token, within its limit), the one with the lowest
// Priority, ties going to the earliest in the account list. Nil when none can.
//
// It scans the pool in place on every pick, so there is no second ordering to
// go stale. An account's weight slots count once and never change its rank.
// The rotation cursor is left alone, so switching back to weighted resumes the
// rotation where it stopped.
func (p *AccountPool) firstByPriorityLocked(model string, excluded map[string]bool) *config.Account {
	allowOverUsage := config.GetAllowOverUsage()
	now := time.Now()
	seen := make(map[string]bool, len(p.accounts))
	var best *config.Account
	for i := range p.accounts {
		acc := &p.accounts[i]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		//! Strictly lower only: an equal priority later in the list never displaces the earlier one.
		if best != nil && acc.Priority >= best.Priority {
			continue
		}
		if !p.canServeLocked(acc, model, excluded, now, allowOverUsage) {
			continue
		}
		best = acc
	}
	if best == nil {
		return nil
	}
	accCopy := *best
	return &accCopy
}

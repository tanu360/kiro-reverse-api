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
// rotation where it stopped. The pick counts as a start for the RPM limit, as
// a weighted pick does.
func (p *AccountPool) firstByPriorityLocked(model string, excluded map[string]bool) *config.Account {
	best := p.bestByPriorityLocked(model, excluded)
	if best == nil {
		return nil
	}
	accCopy := *best
	p.noteRPMStartLocked(accCopy.ID)
	return &accCopy
}

// bestByPriorityLocked is the account firstByPriorityLocked picks, without
// counting the pick for the RPM limit. It points into p.accounts.
func (p *AccountPool) bestByPriorityLocked(model string, excluded map[string]bool) *config.Account {
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
	return best
}

// outrankedLocked reports whether priority routing takes a conversation off
// bound, its session affinity account: in priority mode, an account with a
// lower Priority number can serve model right now. An account of the same
// priority never outranks bound, so the conversation keeps its prompt cache.
// Always false in weighted mode.
func (p *AccountPool) outrankedLocked(bound *config.Account, model string, excluded map[string]bool) bool {
	if config.GetRoutingMode() != config.RoutingModePriority {
		return false
	}
	best := p.bestByPriorityLocked(model, excluded)
	return best != nil && best.Priority < bound.Priority
}

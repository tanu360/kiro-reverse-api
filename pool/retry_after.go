package pool

import "time"

// CooldownRetryAfter is how long until the first account that may serve model leaves its
// cooldown, among allowed (nil is every account). A 503 "No available accounts" sends it as
// Retry-After when every account is cooling down. Zero when no account is cooling.
func (p *AccountPool) CooldownRetryAfter(model string, allowed map[string]bool) time.Duration {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	var soonest time.Duration
	for i := range p.accounts {
		acc := &p.accounts[i]
		if allowed != nil && !allowed[acc.ID] {
			continue
		}
		if model != "" && !p.accountHasModel(acc.ID, model) {
			continue
		}
		until, ok := p.cooldowns[acc.ID]
		if !ok || !now.Before(until) {
			continue
		}
		if wait := until.Sub(now); soonest == 0 || wait < soonest {
			soonest = wait
		}
	}
	return soonest
}

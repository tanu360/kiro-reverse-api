package pool

import (
	"time"

	"kiro-proxy/config"
)

// rpmNow is the RPM limit's clock. Tests pin it to move the window.
var rpmNow = time.Now

// rpmWindow is the sliding window the per-account RPM limit counts over.
const rpmWindow = time.Minute

// rpmStarts remembers when the pool handed each account out, newest last, as
// unix nanoseconds. The zero value is ready to use; p.mu guards it. Starts are
// kept only while the limit is on, and at most limit of them per account.
type rpmStarts struct {
	m map[string][]int64
}

// rpmLimitedLocked reports whether the account already started the limit's
// number of requests in the last minute. It drops starts that left the window.
// Caller holds p.mu for writing.
func (p *AccountPool) rpmLimitedLocked(id string) bool {
	limit := config.GetAccountRPMLimit()
	if limit <= 0 {
		//! Turning the limit off forgets every start, so turning it back on starts clean.
		p.rpm.m = nil
		return false
	}
	starts := p.rpm.trimLocked(id, rpmNow())
	return len(starts) >= limit
}

// noteRPMStartLocked records that the account was just handed out. Caller
// holds p.mu for writing, the same hold that checked rpmLimitedLocked, so two
// concurrent picks can never push an account past the limit.
func (p *AccountPool) noteRPMStartLocked(id string) {
	limit := config.GetAccountRPMLimit()
	if limit <= 0 {
		p.rpm.m = nil
		return
	}
	now := rpmNow()
	starts := append(p.rpm.trimLocked(id, now), now.UnixNano())
	if len(starts) > limit {
		//! A lowered limit only needs the newest starts; older ones cannot change the answer.
		starts = append([]int64(nil), starts[len(starts)-limit:]...)
	}
	if p.rpm.m == nil {
		p.rpm.m = make(map[string][]int64)
	}
	p.rpm.m[id] = starts
}

// trimLocked drops the account's starts at or before now minus the window and
// returns what is left.
func (r *rpmStarts) trimLocked(id string, now time.Time) []int64 {
	starts := r.m[id]
	if len(starts) == 0 {
		return nil
	}
	cutoff := now.Add(-rpmWindow).UnixNano()
	keep := 0
	for keep < len(starts) && starts[keep] <= cutoff {
		keep++
	}
	if keep == len(starts) {
		delete(r.m, id)
		return nil
	}
	if keep > 0 {
		starts = starts[keep:]
		r.m[id] = starts
	}
	return starts
}

// AtRPMLimit returns the accounts that cannot take a new request right now
// because of the per-account RPM limit. It is empty while the limit is off.
func (p *AccountPool) AtRPMLimit() map[string]bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]bool)
	if config.GetAccountRPMLimit() <= 0 {
		p.rpm.m = nil
		return out
	}
	for id := range p.rpm.m {
		if p.rpmLimitedLocked(id) {
			out[id] = true
		}
	}
	return out
}

// BlockedByRPMLimit reports whether the RPM limit is why no account can take a
// request for model: some account in rotation could serve it but for the limit.
// An account that is also cooling down or out of credits does not count, since
// the limit ending would not free it.
func (p *AccountPool) BlockedByRPMLimit(model string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if config.GetAccountRPMLimit() <= 0 {
		p.rpm.m = nil
		return false
	}
	allowOverUsage := config.GetAllowOverUsage()
	now := time.Now()
	seen := make(map[string]bool, len(p.accounts))
	for i := range p.accounts {
		acc := &p.accounts[i]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		if p.eligibleLocked(acc, model, nil, now, allowOverUsage) && p.rpmLimitedLocked(acc.ID) {
			return true
		}
	}
	return false
}

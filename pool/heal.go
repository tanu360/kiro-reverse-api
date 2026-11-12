package pool

import (
	"sync"
	"time"

	"kiro-proxy/config"
)

// CooldownKind says what put an account on cooldown.
type CooldownKind string

const (
	// CooldownQuota waits for the usage to reset, or for an upstream quota hint.
	CooldownQuota CooldownKind = "quota"
	// CooldownError follows three failures in a row.
	CooldownError CooldownKind = "error"
	// CooldownThrottle is the proxy's own backoff after a throttle with no retry hint.
	CooldownThrottle CooldownKind = "throttle"
	// CooldownRetryAfter is a throttle the upstream gave a retry hint for.
	CooldownRetryAfter CooldownKind = "retry_after"
	// CooldownDisabled backs up a disable that Reload may not have seen yet.
	CooldownDisabled CooldownKind = "disabled"
)

// Healable reports whether self-heal may clear a cooldown of this kind: only
// the ones the proxy chose on its own. Quota, an upstream retry hint, a disable
// and an unknown kind (a row saved before kinds existed) run out by themselves.
func (k CooldownKind) Healable() bool {
	return k == CooldownError || k == CooldownThrottle
}

// setKindLocked records what set id's cooldown. Tests build pools as literals,
// so the map is made on first use.
func (p *AccountPool) setKindLocked(id string, kind CooldownKind) {
	if p.cooldownKinds == nil {
		p.cooldownKinds = make(map[string]CooldownKind)
	}
	p.cooldownKinds[id] = kind
}

// throttleKindLocked is the kind a throttle backoff that outgrows id's current
// cooldown takes. An active cooldown self-heal must not clear keeps its kind,
// so a throttle cannot turn a quota wait into a healable one.
func (p *AccountPool) throttleKindLocked(id string, retryAfter time.Duration) CooldownKind {
	if until, ok := p.cooldowns[id]; ok && time.Now().Before(until) && !p.cooldownKinds[id].Healable() {
		return p.cooldownKinds[id]
	}
	if retryAfter > 0 {
		return CooldownRetryAfter
	}
	return CooldownThrottle
}

// CooldownKindOf returns the kind of id's active cooldown, or "" when it has none.
func (p *AccountPool) CooldownKindOf(id string) CooldownKind {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if until, ok := p.cooldowns[id]; !ok || !time.Now().Before(until) {
		return ""
	}
	return p.cooldownKinds[id]
}

var (
	successHookMu sync.RWMutex
	successHook   func(id string)
)

// SetSuccessHook registers fn to run after every RecordSuccess. fn runs outside
// the pool lock, on the request path, and must return quickly.
func SetSuccessHook(fn func(id string)) {
	successHookMu.Lock()
	successHook = fn
	successHookMu.Unlock()
}

func notifySuccess(id string) {
	successHookMu.RLock()
	fn := successHook
	successHookMu.RUnlock()
	if fn != nil {
		fn(id)
	}
}

// HealView is what self-heal needs to know about the pool at one moment.
type HealView struct {
	// Servable is true when some account in rotation can take a request now.
	Servable bool
	// Cooled lists accounts in rotation whose only blocker is a healable cooldown.
	Cooled []string
	// Held marks accounts, in rotation or not, under a cooldown self-heal must leave.
	Held map[string]bool
}

// HealView reports whether any account in rotation can serve, ignoring the
// model, and which accounts a heal could bring back.
func (p *AccountPool) HealView(now time.Time) HealView {
	allowOverUsage := config.GetAllowOverUsage()
	p.mu.RLock()
	defer p.mu.RUnlock()

	view := HealView{Held: make(map[string]bool)}
	for id, until := range p.cooldowns {
		if now.Before(until) && !p.cooldownKinds[id].Healable() {
			view.Held[id] = true
		}
	}
	seen := make(map[string]bool, len(p.accounts))
	for i := range p.accounts {
		acc := &p.accounts[i]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		//! eligibleLocked, not canServeLocked: an account held only by the RPM limit is healthy,
		//! and the RPM check writes its state, which this read lock does not allow.
		if p.eligibleLocked(acc, "", nil, now, allowOverUsage) {
			view.Servable = true
			continue
		}
		if until, ok := p.cooldowns[acc.ID]; !ok || !now.Before(until) || view.Held[acc.ID] {
			continue
		}
		if !rotatable(acc, now, allowOverUsage) {
			continue
		}
		view.Cooled = append(view.Cooled, acc.ID)
	}
	return view
}

// HealCandidate reports whether acc, once enabled and off cooldown, could be
// picked: its token is usable and it is not held back by its usage limit.
func HealCandidate(acc config.Account, now time.Time) bool {
	return rotatable(&acc, now, config.GetAllowOverUsage())
}

func rotatable(acc *config.Account, now time.Time, allowOverUsage bool) bool {
	if tokenUnavailableForSelection(acc, now.Unix()) {
		return false
	}
	return !isOverUsageLimit(*acc) || isUpstreamOverageEnabled(*acc) || allowOverUsage
}

// ClearTransient drops the healable cooldowns of ids and resets their error
// counts, except under a throttle backoff, which keeps its count. Quota,
// retry-hint and disable cooldowns stay. It returns the ids whose cooldown it
// dropped.
func (p *AccountPool) ClearTransient(ids []string) []string {
	now := time.Now()
	p.mu.Lock()
	var cleared []string
	for _, id := range ids {
		until, ok := p.cooldowns[id]
		active := ok && now.Before(until)
		kind := p.cooldownKinds[id]
		//! A throttle heal keeps the error count: the backoff goes on climbing if the
		//! upstream still throttles, instead of falling back to its first minute.
		if !active || kind != CooldownThrottle {
			delete(p.errorCounts, id)
		}
		if !active || !kind.Healable() {
			continue
		}
		delete(p.cooldowns, id)
		delete(p.cooldownKinds, id)
		cleared = append(cleared, id)
	}
	p.mu.Unlock()

	if len(cleared) > 0 {
		_ = p.SaveCooldowns()
		for _, id := range cleared {
			notifyCooldownChanged(id)
		}
	}
	return cleared
}

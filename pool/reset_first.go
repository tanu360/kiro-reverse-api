package pool

import (
	"math"
	"time"

	"kiro-proxy/config"
)

// resetDateLayout is Account.NextResetDate's layout: the reset day in the
// server's time zone, as kiro_api.go writes it.
const resetDateLayout = "2006-01-02"

// resetRank is where reset-first routing puts an account. Credits that reset
// soonest are used first, so they are not lost at the reset.
type resetRank struct {
	// hasCredits is false for an account at or over its credit limit, which can
	// only serve through overage; any account with credits left goes first.
	hasCredits bool
	// resetDay is NextResetDate as a day number; math.MaxInt64 when it is
	// unknown or already past (the usage refresh has not caught up with a
	// reset), so such an account goes after every account with a known date.
	resetDay int64
	// remaining is the credits left; -1 when the limit is unknown.
	remaining float64
}

// resetRankOf ranks acc on now's day. spent is what the account spent since
// its usage was last refreshed (spentSinceRefreshLocked), which UsageCurrent
// does not hold yet.
func resetRankOf(acc config.Account, spent float64, now time.Time) resetRank {
	rank := resetRank{hasCredits: !isOverUsageLimit(acc), resetDay: math.MaxInt64, remaining: -1}
	if acc.UsageLimit > 0 {
		rank.remaining = max(acc.UsageLimit-acc.UsageCurrent-spent, 0)
	}
	if acc.NextResetDate != "" && acc.NextResetDate >= now.Format(resetDateLayout) {
		if t, err := time.Parse(resetDateLayout, acc.NextResetDate); err == nil {
			rank.resetDay = t.Unix() / 86400
		}
	}
	return rank
}

// before reports whether r goes strictly before o: credits left first, then
// the earlier reset day, then more credits left. Equal ranks keep the
// account-list order.
func (r resetRank) before(o resetRank) bool {
	if r.hasCredits != o.hasCredits {
		return r.hasCredits
	}
	if r.resetDay != o.resetDay {
		return r.resetDay < o.resetDay
	}
	return r.remaining > o.remaining
}

// resetOutranks reports whether reset-first routing moves a conversation from
// bound to best: best has credits left and bound has none, or best's credits
// reset on an earlier day. More credits left alone never moves it, so a
// conversation keeps its prompt cache among accounts that reset the same day.
func resetOutranks(best, bound config.Account, now time.Time) bool {
	b, o := resetRankOf(best, 0, now), resetRankOf(bound, 0, now)
	if b.hasCredits != o.hasCredits {
		return b.hasCredits
	}
	return b.resetDay < o.resetDay
}

// firstByResetLocked is the reset-first routing mode's pick: of the accounts
// that can serve model right now (canServeLocked: not excluded, model listed,
// no cooldown, usable token, within its limit and the RPM limit), the one that
// ranks first (resetRank). Nil when none can. Like a priority pick it leaves
// the rotation cursor alone and counts as a start for the RPM limit.
func (p *AccountPool) firstByResetLocked(model string, excluded map[string]bool) *config.Account {
	best := p.bestByResetLocked(model, excluded, time.Now())
	if best == nil {
		return nil
	}
	accCopy := *best
	p.noteRPMStartLocked(accCopy.ID)
	return &accCopy
}

// bestByResetLocked is the account firstByResetLocked picks, without counting
// the pick for the RPM limit. It points into p.accounts.
func (p *AccountPool) bestByResetLocked(model string, excluded map[string]bool, now time.Time) *config.Account {
	allowOverUsage := config.GetAllowOverUsage()
	seen := make(map[string]bool, len(p.accounts))
	var best *config.Account
	var bestRank resetRank
	for i := range p.accounts {
		acc := &p.accounts[i]
		if seen[acc.ID] {
			continue
		}
		seen[acc.ID] = true
		if !p.canServeLocked(acc, model, excluded, now, allowOverUsage) {
			continue
		}
		rank := resetRankOf(*acc, p.spentSinceRefreshLocked(acc), now)
		if best == nil || rank.before(bestRank) {
			best, bestRank = acc, rank
		}
	}
	return best
}

// localSpend is what one account spent since its usage was last refreshed.
type localSpend struct {
	// refreshedAt is the Account.LastRefresh the sum counts from.
	refreshedAt int64
	credits     float64
}

// noteSpend adds credits to what the account spent since its last usage
// refresh, so reset-first ties between refreshes go to the account that really
// has more left, not to the one that had more at the last refresh.
func (p *AccountPool) noteSpend(id string, credits float64) {
	if credits <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.accounts {
		if p.accounts[i].ID != id {
			continue
		}
		if p.spend == nil {
			p.spend = make(map[string]localSpend)
		}
		cur := p.spend[id]
		if cur.refreshedAt != p.accounts[i].LastRefresh {
			cur = localSpend{refreshedAt: p.accounts[i].LastRefresh}
		}
		cur.credits += credits
		p.spend[id] = cur
		return
	}
}

// spentSinceRefreshLocked is what acc spent since its usage was last
// refreshed. A refresh newer than the sum makes it 0: UsageCurrent holds it.
func (p *AccountPool) spentSinceRefreshLocked(acc *config.Account) float64 {
	cur, ok := p.spend[acc.ID]
	if !ok || cur.refreshedAt != acc.LastRefresh {
		return 0
	}
	return cur.credits
}

// SpentSinceRefresh is what the account spent since its usage was last
// refreshed, which its UsageCurrent does not hold yet. 0 for an account out
// of rotation.
func (p *AccountPool) SpentSinceRefresh(id string) float64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for i := range p.accounts {
		if p.accounts[i].ID == id {
			return p.spentSinceRefreshLocked(&p.accounts[i])
		}
	}
	return 0
}

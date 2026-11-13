package pool

import (
	"strings"

	"kiro-proxy/config"
)

// Account allowlists: a client API key may be bound to some accounts, and its
// requests must never land on any other. The pickers below turn every account
// outside the list into one more exclusion and hand off to the plain pickers,
// so rotation, cooldowns and model checks work exactly as for an unbound key.

// allowedPickAttempts bounds the re-picks after a Reload races a pick and
// rotation hands back an account the list does not hold.
const allowedPickAttempts = 3

// AllowedSet is the lookup set for an allowlist. Empty means every account,
// which is nil.
func AllowedSet(ids []string) map[string]bool {
	if len(ids) == 0 {
		return nil
	}
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// GetPreferredForModelAllowed is GetPreferredForModelExcluding limited to the
// accounts in allowed; nil allowed means every account. A preferred account
// outside the list is ignored, and in priority mode only an account in the
// list can outrank the preferred one.
func (p *AccountPool) GetPreferredForModelAllowed(preferredID, model string, excluded, allowed map[string]bool) *config.Account {
	if allowed == nil {
		return p.GetPreferredForModelExcluding(preferredID, model, excluded)
	}
	if !allowed[preferredID] {
		preferredID = ""
	}
	return p.pickAllowed(allowed, excluded, func(merged map[string]bool) *config.Account {
		return p.GetPreferredForModelExcluding(preferredID, model, merged)
	})
}

// GetNextForModelAllowed is GetNextForModelExcluding limited to the accounts
// in allowed; nil allowed means every account.
func (p *AccountPool) GetNextForModelAllowed(model string, excluded, allowed map[string]bool) *config.Account {
	if allowed == nil {
		return p.GetNextForModelExcluding(model, excluded)
	}
	return p.pickAllowed(allowed, excluded, func(merged map[string]bool) *config.Account {
		return p.GetNextForModelExcluding(model, merged)
	})
}

// pickAllowed runs pick with the caller's exclusions plus every account
// outside allowed. The pick takes the pool lock again, so a Reload in between
// can add an account; the result is checked against allowed and, on a miss,
// picked again from fresh exclusions.
func (p *AccountPool) pickAllowed(allowed, excluded map[string]bool, pick func(map[string]bool) *config.Account) *config.Account {
	for attempt := 0; attempt < allowedPickAttempts; attempt++ {
		acc := pick(p.excludeOutside(allowed, excluded))
		if acc == nil || allowed[acc.ID] {
			return acc
		}
	}
	return nil
}

// excludeOutside is a new exclusion set: the caller's, plus every pooled
// account allowed does not hold. The caller's map is never written.
func (p *AccountPool) excludeOutside(allowed, excluded map[string]bool) map[string]bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	merged := make(map[string]bool, len(excluded)+len(p.enabledIDs))
	for id, out := range excluded {
		if out {
			merged[id] = true
		}
	}
	for i := range p.accounts {
		if id := p.accounts[i].ID; !allowed[id] {
			merged[id] = true
		}
	}
	return merged
}

// AllowedOffersModel reports whether an enabled account in allowed may serve
// model. It is OffersModel for one key: nil allowed asks the whole pool, and
// an allowlist with no enabled account offers nothing.
func (p *AccountPool) AllowedOffersModel(allowed map[string]bool, model string) bool {
	if allowed == nil {
		return p.OffersModel(model)
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	//! Over-limit accounts are out of rotation but still offer their models, as in OffersModel.
	for _, id := range p.enabledIDs {
		if allowed[id] && p.accountHasModel(id, model) {
			return true
		}
	}
	for i := range p.accounts {
		if id := p.accounts[i].ID; allowed[id] && p.accountHasModel(id, model) {
			return true
		}
	}
	return false
}

// AllowedKnowsModel is the model check behind a "no account" error for one
// key. Like OffersModel it answers true when none of the key's accounts is in
// the pool (all disabled or removed), so that request gets a capacity error
// (503), not 404. Otherwise it is AllowedOffersModel: a model none of the
// key's accounts lists is unknown to this key, even when other accounts serve
// it, matching what its /v1/models shows.
func (p *AccountPool) AllowedKnowsModel(allowed map[string]bool, model string) bool {
	if allowed == nil {
		return p.OffersModel(model)
	}
	if strings.TrimSpace(model) == "" {
		return true
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	pooled := false
	for _, id := range p.enabledIDs {
		if allowed[id] {
			pooled = true
			if p.accountHasModel(id, model) {
				return true
			}
		}
	}
	for i := range p.accounts {
		if id := p.accounts[i].ID; allowed[id] {
			pooled = true
			if p.accountHasModel(id, model) {
				return true
			}
		}
	}
	return !pooled
}

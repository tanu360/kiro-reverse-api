package pool

import (
	"strings"

	"kiro-proxy/config"
)

// Account allowlists: a client API key may be bound to some accounts, and its
// requests must never land on any other. The pickers below turn every account
// outside the list into one more exclusion and hand off to the plain pickers,
// so rotation, cooldowns and model checks work exactly as for an unbound key.

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

// Scope is one client API key's view of the pool. Allowed is the accounts the
// key may use: nil is every account, and an empty set is none (a key whose
// account tags match no account). Mode is the routing mode its picks use: ""
// is the global routing mode.
type Scope struct {
	Allowed map[string]bool
	Mode    string
}

// GetPreferredForModelAllowed is GetPreferredForModelExcluding limited to the
// accounts in allowed; nil allowed means every account. A preferred account
// outside the list is ignored, and in priority mode only an account in the
// list can outrank the preferred one.
func (p *AccountPool) GetPreferredForModelAllowed(preferredID, model string, excluded, allowed map[string]bool) *config.Account {
	return p.GetPreferredForModelScoped(preferredID, model, excluded, Scope{Allowed: allowed})
}

// GetPreferredForModelScoped is GetPreferredForModelAllowed with the key's own
// routing mode: the preferred account is kept, or outranked, by scope.Mode's
// rules, and a new pick uses scope.Mode.
func (p *AccountPool) GetPreferredForModelScoped(preferredID, model string, excluded map[string]bool, scope Scope) *config.Account {
	return p.getPreferredForModel(preferredID, model, excluded, scope)
}

// GetNextForModelAllowed is GetNextForModelExcluding limited to the accounts
// in allowed; nil allowed means every account.
func (p *AccountPool) GetNextForModelAllowed(model string, excluded, allowed map[string]bool) *config.Account {
	return p.GetNextForModelScoped(model, excluded, Scope{Allowed: allowed})
}

// GetNextForModelScoped is GetNextForModelAllowed with the key's own routing mode.
func (p *AccountPool) GetNextForModelScoped(model string, excluded map[string]bool, scope Scope) *config.Account {
	return p.getNextForModel(model, excluded, scope)
}

// excludeOutsideLocked is the exclusions a pick limited to allowed uses: the
// caller's, plus every pooled account allowed does not hold, as a new set. Nil
// allowed is every account, so the caller's set comes back as it is. The
// caller's map is never written. Caller holds p.mu.
func (p *AccountPool) excludeOutsideLocked(allowed, excluded map[string]bool) map[string]bool {
	if allowed == nil {
		return excluded
	}
	merged := make(map[string]bool, len(excluded)+len(p.accounts))
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

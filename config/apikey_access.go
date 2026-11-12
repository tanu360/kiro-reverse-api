package config

import (
	"errors"
	"fmt"
	"strings"
)

// Client API key access: the account allowlist, the successful-call limit and
// regenerating a key's secret in place.

var (
	ErrCallLimitNegative    = errors.New("call limit must be zero or positive")
	ErrApiKeyUnknownAccount = errors.New("api key lists an account that does not exist")
	// ErrApiKeyCallLimitExceeded wraps every call limit refusal; its text leads
	// the message clients get with the 429.
	ErrApiKeyCallLimitExceeded = errors.New("API key call limit reached")
)

// regenerateApiKeyAttempts bounds the retries when a fresh value collides with
// another key. Two 256-bit random values never collide in practice.
const regenerateApiKeyAttempts = 5

// apiKeyPendingCalls counts, per key id, calls that hold a reservation and have
// not finished yet. The call limit counts them as used, so concurrent requests
// cannot overrun it. It lives in memory only: a restart ends every call it
// counts. Guarded by cfgLock.
var apiKeyPendingCalls = map[string]int64{}

// credentialAccountIDs is the set of account ids in the credentials store, or
// nil when that store is not the active one and cfg.Accounts holds the
// accounts (the same choice GetAccounts makes). Callers read it before they
// take cfgLock, so credLock is never taken under cfgLock here.
func credentialAccountIDs() map[string]bool {
	credLock.RLock()
	defer credLock.RUnlock()
	if !credLoaded {
		return nil
	}
	ids := make(map[string]bool, len(credentials))
	for i := range credentials {
		ids[credentials[i].ID] = true
	}
	return ids
}

// normalizeApiKeyAccountIDsLocked trims, drops blanks and duplicates, and checks
// that every id is a stored account: one in credIDs when the credentials store
// is active (credIDs from credentialAccountIDs), else one in cfg.Accounts. An
// id already on the key (previous) stays valid after its account is deleted,
// so a stale id never blocks an unrelated edit. An empty result is nil: every
// account. Caller holds cfgLock.
func normalizeApiKeyAccountIDsLocked(ids, previous []string, credIDs map[string]bool) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	known := make(map[string]bool, len(cfg.Accounts)+len(credIDs)+len(previous))
	if credIDs != nil {
		for id := range credIDs {
			known[id] = true
		}
	} else {
		for i := range cfg.Accounts {
			known[cfg.Accounts[i].ID] = true
		}
	}
	for _, id := range previous {
		known[id] = true
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		if !known[id] {
			return nil, ErrApiKeyUnknownAccount
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func validateApiKeyCallLimit(limit int64) error {
	if limit < 0 {
		return ErrCallLimitNegative
	}
	return nil
}

// callLimitError is the 429 text for a key out of calls. In-progress calls are
// named only when they, not finished ones, fill the limit.
func callLimitError(limit, used, pending int64) error {
	if pending > 0 && used < limit {
		return fmt.Errorf("%w: %d of %d successful calls used, %d more in progress", ErrApiKeyCallLimitExceeded, used, limit, pending)
	}
	return fmt.Errorf("%w: %d of %d successful calls used", ErrApiKeyCallLimitExceeded, used, limit)
}

// ApiKeyCallLimitError reports a key that has used up its call limit, or nil.
// Calls still in progress do not count here; the reservation counts them.
func ApiKeyCallLimitError(entry ApiKeyEntry) error {
	if entry.CallLimit > 0 && entry.SuccessfulCalls >= entry.CallLimit {
		return callLimitError(entry.CallLimit, entry.SuccessfulCalls, 0)
	}
	return nil
}

// reserveCallSlotLocked takes one of the key's remaining calls for a request
// that is starting, or refuses when finished plus in-progress calls fill the
// limit. Caller holds cfgLock for writing.
func reserveCallSlotLocked(i int) error {
	entry := &cfg.ApiKeys[i]
	pending := apiKeyPendingCalls[entry.ID]
	if entry.CallLimit > 0 && entry.SuccessfulCalls+pending >= entry.CallLimit {
		return callLimitError(entry.CallLimit, entry.SuccessfulCalls, pending)
	}
	apiKeyPendingCalls[entry.ID] = pending + 1
	return nil
}

// releaseCallSlotLocked gives back a call reserved by reserveCallSlotLocked.
// Caller holds cfgLock for writing.
func releaseCallSlotLocked(id string) {
	if n := apiKeyPendingCalls[id]; n > 1 {
		apiKeyPendingCalls[id] = n - 1
		return
	}
	delete(apiKeyPendingCalls, id)
}

// ApiKeyAccountIDs returns a copy of the key's allowlist; nil means every account.
func ApiKeyAccountIDs(entry ApiKeyEntry) []string {
	if len(entry.AccountIDs) == 0 {
		return nil
	}
	return append([]string(nil), entry.AccountIDs...)
}

// RegenerateApiKey gives the key a fresh random value and keeps its id, name,
// state, limits, usage and allowlist. Requests are matched against the live
// config, so the old value stops working as soon as this returns.
func RegenerateApiKey(id string) (ApiKeyEntry, error) {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return ApiKeyEntry{}, errors.New("config not initialized")
	}
	idx := -1
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ApiKeyEntry{}, ErrApiKeyNotFound
	}
	next := ""
	for attempt := 0; attempt < regenerateApiKeyAttempts && next == ""; attempt++ {
		candidate := GenerateApiKeyValue()
		taken := false
		for j := range cfg.ApiKeys {
			if cfg.ApiKeys[j].Key == candidate {
				taken = true
				break
			}
		}
		if !taken {
			next = candidate
		}
	}
	if next == "" {
		return ApiKeyEntry{}, ErrApiKeyCollision
	}
	previous := cfg.ApiKeys[idx].Key
	cfg.ApiKeys[idx].Key = next
	if err := Save(); err != nil {
		cfg.ApiKeys[idx].Key = previous
		return ApiKeyEntry{}, err
	}
	out := cfg.ApiKeys[idx]
	out.AccountIDs = ApiKeyAccountIDs(out)
	return out, nil
}

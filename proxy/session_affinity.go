package proxy

import (
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"sync"
	"time"
)

const (
	// sessionAffinityTTL outlives the longest prompt cache TTL (1h), so a
	// binding never lapses while its account can still hold the cache.
	sessionAffinityTTL = time.Hour
	// maxSessionAffinityEntries caps memory when every request opens a new
	// conversation.
	maxSessionAffinityEntries = 10000
)

type sessionAffinityEntry struct {
	accountID string
	expiresAt time.Time
}

// sessionAffinity remembers which account served each conversation. Keys are
// the payload's ConversationID, which the translator derives from the model,
// system prompt and first user message. Every turn of one conversation maps
// to one key, while separate conversations still spread across the pool.
type sessionAffinity struct {
	mu      sync.Mutex
	entries map[string]sessionAffinityEntry
}

func newSessionAffinity() *sessionAffinity {
	return &sessionAffinity{entries: make(map[string]sessionAffinityEntry)}
}

func (s *sessionAffinity) Lookup(key string) string {
	if s == nil || key == "" {
		return ""
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[key]
	if !ok {
		return ""
	}
	if now.After(entry.expiresAt) {
		delete(s.entries, key)
		return ""
	}
	return entry.accountID
}

func (s *sessionAffinity) Bind(key, accountID string) {
	if s == nil || key == "" || accountID == "" {
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[key]; !ok && len(s.entries) >= maxSessionAffinityEntries {
		s.evictLocked(now)
	}
	s.entries[key] = sessionAffinityEntry{accountID: accountID, expiresAt: now.Add(sessionAffinityTTL)}
}

// evictLocked drops expired bindings, then enough others to get the map back
// under 90% full. Map order is random, so the extra drops are arbitrary; a
// dropped conversation only loses its next cache hit. Evicting in bulk keeps
// the full-map scan off most inserts.
func (s *sessionAffinity) evictLocked(now time.Time) {
	for key, entry := range s.entries {
		if now.After(entry.expiresAt) {
			delete(s.entries, key)
		}
	}
	excess := len(s.entries) - maxSessionAffinityEntries*9/10
	for key := range s.entries {
		if excess <= 0 {
			break
		}
		delete(s.entries, key)
		excess--
	}
}

func affinityKey(payload *KiroPayload) string {
	if payload == nil {
		return ""
	}
	return payload.ConversationState.ConversationID
}

// pickAccount chooses the account for one attempt. With affinity on, a
// follow-up turn returns to the account that served the conversation last, as
// long as that account can still serve; otherwise round-robin decides.
func (h *Handler) pickAccount(payload *KiroPayload, model string, excluded map[string]bool) *config.Account {
	preferred := ""
	if config.GetSessionAffinity() {
		preferred = h.affinity.Lookup(affinityKey(payload))
	}
	account := h.pool.GetPreferredForModelExcluding(preferred, model, excluded)
	//! A move off the bound account costs the conversation its prompt cache; log it so a cache-miss spike can be traced.
	if preferred != "" && account != nil && account.ID != preferred {
		logger.Debugf("[SessionAffinity] Bound account %s unavailable, conversation moved to %s", preferred, account.Email)
	}
	return account
}

// rememberAccount binds the conversation to the account that just served it.
// Binding on success, not on pick, means a failed attempt never pins a
// conversation to an account that could not answer it.
func (h *Handler) rememberAccount(payload *KiroPayload, account *config.Account) {
	if account == nil || !config.GetSessionAffinity() {
		return
	}
	h.affinity.Bind(affinityKey(payload), account.ID)
}

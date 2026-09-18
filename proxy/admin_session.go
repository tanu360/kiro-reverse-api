package proxy

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"net/http"
	"sync"
	"time"
)

const (
	// adminSessionTTL bounds how long a stolen browser token stays useful.
	adminSessionTTL = 12 * time.Hour
	// adminTicketTTL covers one EventSource connect. Tickets ride in a URL, so
	// they expire fast enough that an access log entry is worthless.
	adminTicketTTL = 30 * time.Second
	// maxAdminSessions caps memory growth from repeated logins.
	maxAdminSessions = 128
)

// secureCompare compares two secrets without leaking their common prefix length.
func secureCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func newSecret() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate admin token: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// adminSessionStore holds admin credentials the browser can carry instead of the
// password itself: a session token sent as a header, and single-use tickets for
// EventSource, which cannot set headers.
type adminSessionStore struct {
	mu       sync.Mutex
	sessions map[string]time.Time
	tickets  map[string]time.Time
}

func newAdminSessionStore() *adminSessionStore {
	return &adminSessionStore{
		sessions: make(map[string]time.Time),
		tickets:  make(map[string]time.Time),
	}
}

func (s *adminSessionStore) pruneLocked(now time.Time) {
	for token, expiry := range s.sessions {
		if now.After(expiry) {
			delete(s.sessions, token)
		}
	}
	for ticket, expiry := range s.tickets {
		if now.After(expiry) {
			delete(s.tickets, ticket)
		}
	}
}

// Issue mints a session token. The caller must have already verified the
// password.
func (s *adminSessionStore) Issue() (string, time.Time, error) {
	token, err := newSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	expiry := now.Add(adminSessionTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	//! Oldest-first eviction keeps a login loop from pinning unbounded memory.
	for len(s.sessions) >= maxAdminSessions {
		oldest, oldestExpiry := "", time.Time{}
		for candidate, candidateExpiry := range s.sessions {
			if oldest == "" || candidateExpiry.Before(oldestExpiry) {
				oldest, oldestExpiry = candidate, candidateExpiry
			}
		}
		delete(s.sessions, oldest)
	}
	s.sessions[token] = expiry
	return token, expiry, nil
}

func (s *adminSessionStore) Valid(token string) bool {
	if token == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.sessions[token]
	if !ok {
		return false
	}
	if now.After(expiry) {
		delete(s.sessions, token)
		return false
	}
	return true
}

func (s *adminSessionStore) Revoke(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// RevokeAll invalidates every session. Called when the password changes, so a
// rotation actually locks out whoever held the old credential.
func (s *adminSessionStore) RevokeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = make(map[string]time.Time)
	s.tickets = make(map[string]time.Time)
}

// IssueTicket mints a single-use credential for one EventSource connect.
func (s *adminSessionStore) IssueTicket() (string, time.Time, error) {
	ticket, err := newSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	expiry := now.Add(adminTicketTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	s.tickets[ticket] = expiry
	return ticket, expiry, nil
}

// ConsumeTicket validates a ticket and burns it, so a ticket captured from an
// access log cannot be replayed.
func (s *adminSessionStore) ConsumeTicket(ticket string) bool {
	if ticket == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.tickets[ticket]
	delete(s.tickets, ticket)
	return ok && !now.After(expiry)
}

// apiCreateAdminSession exchanges the admin password for a session token. The
// browser stores the token instead of the password, so a token stolen through
// XSS expires on its own and can be revoked by changing the password.
func (h *Handler) apiCreateAdminSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	supplied := req.Password
	if supplied == "" {
		supplied = r.Header.Get("X-Admin-Password")
	}
	if !adminPasswordMatches(supplied) {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
		return
	}

	token, expiry, err := h.adminSessions.Issue()
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if err := config.ClearFirstRunPassword(); err != nil {
		logger.Warnf("[Admin] Failed to hide first-run password: %v", err)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":     token,
		"expiresAt": expiry.UnixMilli(),
	})
}

func (h *Handler) apiDeleteAdminSession(w http.ResponseWriter, r *http.Request) {
	h.adminSessions.Revoke(r.Header.Get("X-Admin-Token"))
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// apiCreateAdminTicket mints the single-use credential EventSource needs.
func (h *Handler) apiCreateAdminTicket(w http.ResponseWriter, _ *http.Request) {
	ticket, expiry, err := h.adminSessions.IssueTicket()
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ticket":    ticket,
		"expiresAt": expiry.UnixMilli(),
	})
}

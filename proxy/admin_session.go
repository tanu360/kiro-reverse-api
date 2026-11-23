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
	"strings"
	"sync"
	"time"
)

const (
	// adminSessionTTL bounds how long a stolen browser token stays useful.
	adminSessionTTL = 12 * time.Hour
	// adminRememberTTL is a "Stay signed in" sign-in's life. The token then sits in
	// localStorage, so it outlives the browser; changing the password still ends it.
	adminRememberTTL = 30 * 24 * time.Hour
	// adminTicketTTL covers one EventSource connect. Tickets ride in a URL, so
	// they expire fast enough that an access log entry is worthless.
	adminTicketTTL = 30 * time.Second
	// maxAdminSessions caps memory growth from repeated logins.
	maxAdminSessions = 128
)

// adminSessionLife is how long a sign-in lasts: adminRememberTTL with "Stay signed in".
func adminSessionLife(remember bool) time.Duration {
	if remember {
		return adminRememberTTL
	}
	return adminSessionTTL
}

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
	mu sync.Mutex
	// sessions is keyed by hashSessionToken, as web_sessions is.
	sessions map[string]time.Time
	tickets  map[string]time.Time
	// table saves sessions to the database once restore turns it on. Tickets are never saved:
	// they last seconds.
	table sessionTable
}

func newAdminSessionStore() *adminSessionStore {
	return &adminSessionStore{
		sessions: make(map[string]time.Time),
		tickets:  make(map[string]time.Time),
	}
}

func (s *adminSessionStore) pruneLocked(now time.Time) {
	for hash, expiry := range s.sessions {
		if now.After(expiry) {
			delete(s.sessions, hash)
		}
	}
	for ticket, expiry := range s.tickets {
		if now.After(expiry) {
			delete(s.tickets, ticket)
		}
	}
}

// Issue mints a session token that lasts adminSessionLife(remember). The caller must have
// already verified the password.
func (s *adminSessionStore) Issue(remember bool) (string, time.Time, error) {
	token, err := newSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	expiry := now.Add(adminSessionLife(remember))
	hash := hashSessionToken(token)

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
		s.table.delete(oldest)
	}
	s.sessions[hash] = expiry
	s.table.save(storedSession{tokenHash: hash, expiry: expiry}, now)
	return token, expiry, nil
}

func (s *adminSessionStore) Valid(token string) bool {
	if token == "" {
		return false
	}
	hash := hashSessionToken(token)
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.sessions[hash]
	if !ok {
		return false
	}
	if now.After(expiry) {
		delete(s.sessions, hash)
		s.table.delete(hash)
		return false
	}
	return true
}

func (s *adminSessionStore) Revoke(token string) {
	if token == "" {
		return
	}
	hash := hashSessionToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, hash)
	s.table.delete(hash)
}

// RevokeAll invalidates every session. Called when the password changes, so a
// rotation actually locks out whoever held the old credential.
func (s *adminSessionStore) RevokeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = make(map[string]time.Time)
	s.tickets = make(map[string]time.Time)
	s.table.deleteAllExcept("")
}

// RevokeAllExcept invalidates every session but keep, as turning two-factor
// sign-in on does: the session that turned it on just proved a code.
func (s *adminSessionStore) RevokeAllExcept(keep string) {
	hash := ""
	if keep != "" {
		hash = hashSessionToken(keep)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.sessions[hash]
	s.sessions = make(map[string]time.Time)
	s.tickets = make(map[string]time.Time)
	if ok && hash != "" {
		s.sessions[hash] = expiry
	} else {
		hash = ""
	}
	s.table.deleteAllExcept(hash)
}

// restore turns saving on and takes back the sessions an earlier run saved: unexpired ones,
// none past adminRememberTTL from now, within the cap. It returns how many it kept.
func (s *adminSessionStore) restore() (int, error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.table = sessionTable{kind: sessionKindAdmin}
	list, err := s.table.load(now)
	if err != nil {
		return 0, err
	}
	s.pruneLocked(now)
	latest := now.Add(adminRememberTTL)
	kept := 0
	for _, row := range list {
		if row.tokenHash == "" || len(s.sessions) >= maxAdminSessions {
			continue
		}
		if row.expiry.After(latest) {
			row.expiry = latest
		}
		s.sessions[row.tokenHash] = row.expiry
		kept++
	}
	return kept, nil
}

// sessionHandoff is one session as Export writes it. Export writes TokenHash; Token is what a
// release from before sessions were saved by hash wrote, and Import still takes it.
type sessionHandoff struct {
	Token     string    `json:"token,omitempty"`
	TokenHash string    `json:"tokenHash,omitempty"`
	Expires   time.Time `json:"expires"`
}

// handoffHash returns the session key a handoff entry names, or "" for neither or an oversized one.
func handoffHash(token, tokenHash string) string {
	switch {
	case tokenHash != "" && len(tokenHash) <= maxHandoffTokenLen:
		return tokenHash
	case token != "" && len(token) <= maxHandoffTokenLen:
		return hashSessionToken(token)
	}
	return ""
}

// maxHandoffTokenLen bounds an imported token; the store's own are 64 characters.
const maxHandoffTokenLen = 256

// Export returns the unexpired sessions with their expiry as JSON, or nil when there are none,
// so the process a self-update restarts into keeps the admin signed in. EventSource tickets are
// left out: they last seconds, and the page asks for a new one when it reconnects.
func (s *adminSessionStore) Export() []byte {
	now := time.Now()
	s.mu.Lock()
	s.pruneLocked(now)
	list := make([]sessionHandoff, 0, len(s.sessions))
	for hash, expiry := range s.sessions {
		list = append(list, sessionHandoff{TokenHash: hash, Expires: expiry})
	}
	s.mu.Unlock()
	if len(list) == 0 {
		return nil
	}
	data, err := json.Marshal(list)
	if err != nil {
		return nil
	}
	return data
}

// Import adds the sessions Export wrote and returns how many it kept. Expired ones are dropped,
// none outlives adminRememberTTL from now, and the store's cap still holds.
func (s *adminSessionStore) Import(data []byte) int {
	var list []sessionHandoff
	if err := json.Unmarshal(data, &list); err != nil {
		return 0
	}
	now := time.Now()
	latest := now.Add(adminRememberTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	kept := 0
	for _, entry := range list {
		hash := handoffHash(entry.Token, entry.TokenHash)
		if hash == "" || !entry.Expires.After(now) {
			continue
		}
		if len(s.sessions) >= maxAdminSessions {
			break
		}
		if entry.Expires.After(latest) {
			entry.Expires = latest
		}
		s.sessions[hash] = entry.Expires
		s.table.save(storedSession{tokenHash: hash, expiry: entry.Expires}, now)
		kept++
	}
	return kept
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
//
// With two-factor sign-in on it takes two steps: the password answers
// {"twoFactorRequired": true, "challenge": ...}, and the challenge with a code
// or a recovery code answers the token. A script may send the password and the
// code at once.
func (h *Handler) apiCreateAdminSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password     string `json:"password"`
		Challenge    string `json:"challenge"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recoveryCode"`
		// Remember is "Stay signed in": the token lasts adminRememberTTL instead of
		// adminSessionTTL. With two-factor on, the request that answers the token decides.
		Remember bool `json:"remember"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req)

	if req.Challenge != "" {
		if !config.AdminTOTPEnabled() || !h.totpState().challengeValid(req.Challenge, time.Now()) {
			writeAdminError(w, http.StatusUnauthorized, codeTOTPChallengeExpired, "The sign-in expired; enter the password again")
			return
		}
		if !h.checkSecondFactor(w, r, req.Code, req.RecoveryCode, http.StatusUnauthorized) {
			h.totpState().challengeFailed(req.Challenge)
			return
		}
		h.totpState().consumeChallenge(req.Challenge)
		h.issueAdminSession(w, req.Remember)
		return
	}

	supplied := req.Password
	if supplied == "" {
		supplied = r.Header.Get("X-Admin-Password")
	}
	if !h.checkAdminPassword(w, r, supplied) {
		return
	}
	if config.AdminTOTPEnabled() {
		if strings.TrimSpace(req.Code) != "" || strings.TrimSpace(req.RecoveryCode) != "" {
			if !h.checkSecondFactor(w, r, req.Code, req.RecoveryCode, http.StatusUnauthorized) {
				return
			}
			h.issueAdminSession(w, req.Remember)
			return
		}
		challenge, expiry, err := h.totpState().issueChallenge(time.Now())
		if err != nil {
			writeInternalError(w, err)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"twoFactorRequired": true,
			"challenge":         challenge,
			"expiresAt":         expiry.UnixMilli(),
		})
		return
	}
	h.issueAdminSession(w, req.Remember)
}

func (h *Handler) issueAdminSession(w http.ResponseWriter, remember bool) {
	token, expiry, err := h.adminSessions.Issue(remember)
	if err != nil {
		writeInternalError(w, err)
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
		writeInternalError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ticket":    ticket,
		"expiresAt": expiry.UnixMilli(),
	})
}

package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"time"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// The kinds of sign-in web_sessions keeps apart.
const (
	sessionKindAdmin = "admin"
	sessionKindUser  = "user"
)

// hashSessionToken is the key a session is kept under, in memory and in the database. The token
// itself lives only in the browser, so a copy of the database signs nobody in.
func hashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// storedSession is one row of web_sessions. keyID and keyHash are the user panel's only.
type storedSession struct {
	tokenHash string
	keyID     string
	keyHash   string
	expiry    time.Time
}

// sessionTable saves one kind of sign-in to web_sessions, so a restart or a redeploy keeps it.
// The zero value saves nothing: a store starts that way, and the server turns saving on
// (Handler.LoadSessions) once the database is open, so tests that never open one write nowhere.
//
// The stores call it while holding their own lock. That keeps the table in the order the
// changes happened: a revoke that races a sign-in can never leave a row that a restart would
// bring back to life.
type sessionTable struct {
	kind string
}

func (t sessionTable) exec(query string, args ...any) {
	if t.kind == "" {
		return
	}
	d, err := db.Get()
	if err == nil {
		_, err = d.Exec(query, args...)
	}
	if err != nil {
		logger.Warnf("[Session] Failed to save %s sign-ins: %v", t.kind, err)
	}
}

// save writes s and drops this kind's expired rows.
func (t sessionTable) save(s storedSession, now time.Time) {
	t.exec(`DELETE FROM web_sessions WHERE kind=? AND expires_at<=?`, t.kind, now.UnixMilli())
	t.exec(`INSERT OR REPLACE INTO web_sessions(token_hash, kind, key_id, key_hash, expires_at) VALUES(?, ?, ?, ?, ?)`,
		s.tokenHash, t.kind, s.keyID, s.keyHash, s.expiry.UnixMilli())
}

func (t sessionTable) delete(tokenHash string) {
	t.exec(`DELETE FROM web_sessions WHERE kind=? AND token_hash=?`, t.kind, tokenHash)
}

// deleteAllExcept drops every row of this kind but keep's; an empty keep drops them all.
func (t sessionTable) deleteAllExcept(keep string) {
	t.exec(`DELETE FROM web_sessions WHERE kind=? AND token_hash<>?`, t.kind, keep)
}

// load returns this kind's unexpired rows, latest expiry first, so a cap keeps the newest.
func (t sessionTable) load(now time.Time) ([]storedSession, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`DELETE FROM web_sessions WHERE kind=? AND expires_at<=?`, t.kind, now.UnixMilli()); err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT token_hash, key_id, key_hash, expires_at FROM web_sessions WHERE kind=? ORDER BY expires_at DESC`, t.kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []storedSession
	for rows.Next() {
		var s storedSession
		var expires int64
		if err := rows.Scan(&s.tokenHash, &s.keyID, &s.keyHash, &expires); err != nil {
			return nil, err
		}
		s.expiry = time.UnixMilli(expires)
		list = append(list, s)
	}
	return list, rows.Err()
}

// LoadSessions turns on saving sign-ins to the database and takes back the ones an earlier run
// saved, so a restart or a redeploy signs nobody out. main calls it once the database is open,
// before it imports an update's handoff.
func (h *Handler) LoadSessions() {
	if n, err := h.adminSessions.restore(); err != nil {
		logger.Warnf("[Session] Failed to load admin sign-ins: %v", err)
	} else if n > 0 {
		logger.Infof("[Session] Kept %d admin sign-in(s) from the last run", n)
	}
	if n, err := h.userSessions.restore(); err != nil {
		logger.Warnf("[Session] Failed to load key holder sign-ins: %v", err)
	} else if n > 0 {
		logger.Infof("[Session] Kept %d key holder sign-in(s) from the last run", n)
	}
}

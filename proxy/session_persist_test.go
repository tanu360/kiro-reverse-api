package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// withSessionDB gives the test a fresh kiro.db for web_sessions.
func withSessionDB(t *testing.T) {
	t.Helper()
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
}

func savedSessionHashes(t *testing.T, kind string) []string {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	rows, err := d.Query(`SELECT token_hash FROM web_sessions WHERE kind=? ORDER BY token_hash`, kind)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var hashes []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, hash)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return hashes
}

// restartedAdminStore is the store a restarted server builds from the same database.
func restartedAdminStore(t *testing.T) *adminSessionStore {
	t.Helper()
	next := newAdminSessionStore()
	if _, err := next.restore(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	return next
}

// A restart or a redeploy keeps the admin signed in, and the database holds only the token's
// hash, so a copy of it signs nobody in.
func TestAdminSessionsSurviveARestart(t *testing.T) {
	withSessionDB(t)
	store := newAdminSessionStore()
	if _, err := store.restore(); err != nil {
		t.Fatal(err)
	}
	token, _, err := store.Issue(true)
	if err != nil {
		t.Fatal(err)
	}
	if got := savedSessionHashes(t, sessionKindAdmin); len(got) != 1 || got[0] != hashSessionToken(token) {
		t.Fatalf("saved %v, want only the token's hash", got)
	}
	if !restartedAdminStore(t).Valid(token) {
		t.Fatal("the sign-in did not survive the restart")
	}

	store.Revoke(token)
	if restartedAdminStore(t).Valid(token) {
		t.Fatal("a revoked sign-in came back after the restart")
	}
}

// Changing the password ends every sign-in for good: a restart must not bring one back.
func TestAdminRevokeAllSurvivesARestart(t *testing.T) {
	withSessionDB(t)
	store := newAdminSessionStore()
	if _, err := store.restore(); err != nil {
		t.Fatal(err)
	}
	a, _, _ := store.Issue(true)
	b, _, _ := store.Issue(false)
	keep, _, _ := store.Issue(true)

	store.RevokeAllExcept(keep)
	next := restartedAdminStore(t)
	if next.Valid(a) || next.Valid(b) || !next.Valid(keep) {
		t.Fatal("RevokeAllExcept did not carry over the restart")
	}

	store.RevokeAll()
	if restartedAdminStore(t).Valid(keep) || len(savedSessionHashes(t, sessionKindAdmin)) != 0 {
		t.Fatal("RevokeAll left a sign-in a restart brings back")
	}
}

// Rows past their expiry stay out, and a row with an expiry past the longest TTL is cut back.
func TestAdminSessionRestoreDropsExpiredAndCapsTTL(t *testing.T) {
	withSessionDB(t)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for hash, expiry := range map[string]time.Time{
		"old": now.Add(-time.Minute),
		"far": now.Add(365 * 24 * time.Hour),
	} {
		if _, err := d.Exec(`INSERT INTO web_sessions(token_hash, kind, expires_at) VALUES(?, ?, ?)`,
			hash, sessionKindAdmin, expiry.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	store := restartedAdminStore(t)
	if _, ok := store.sessions["old"]; ok {
		t.Fatal("an expired sign-in came back")
	}
	if got := store.sessions["far"]; got.After(time.Now().Add(adminRememberTTL)) {
		t.Fatalf("restored expiry %v outlives adminRememberTTL", got)
	}
	if got := savedSessionHashes(t, sessionKindAdmin); len(got) != 1 || got[0] != "far" {
		t.Fatalf("expired row left in the table: %v", got)
	}
}

// A store whose saving was never turned on (every test that builds a Handler) writes nothing.
func TestSessionsAreNotSavedUntilRestored(t *testing.T) {
	withSessionDB(t)
	if _, _, err := newAdminSessionStore().Issue(true); err != nil {
		t.Fatal(err)
	}
	if got := savedSessionHashes(t, sessionKindAdmin); len(got) != 0 {
		t.Fatalf("saved %v before restore turned saving on", got)
	}
}

func adminSignIn(t *testing.T, h http.Handler, body string) int64 {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/admin/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in: %d %s", rec.Code, rec.Body.String())
	}
	var issued struct {
		ExpiresAt int64 `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	return issued.ExpiresAt
}

func assertNear(t *testing.T, what string, got, want, slack int64) {
	t.Helper()
	if got < want-slack || got > want+slack {
		t.Fatalf("%s %d, want near %d", what, got, want)
	}
}

// "Stay signed in" makes the sign-in last adminRememberTTL; without it, adminSessionTTL.
func TestAdminSignInRememberExtendsTheSession(t *testing.T) {
	const password = "admin-password"
	h := newAdminAuthTestHandler(t, password)

	got := adminSignIn(t, h, `{"password":"`+password+`"}`)
	assertNear(t, "expiresAt", got, time.Now().Add(adminSessionTTL).UnixMilli(), 5000)

	got = adminSignIn(t, h, `{"password":"`+password+`","remember":true}`)
	assertNear(t, "remembered expiresAt", got, time.Now().Add(adminRememberTTL).UnixMilli(), 5000)
}

// The user panel's "Stay signed in" lasts userRememberTTL, and survives a restart; a key
// regenerated meanwhile still ends it.
func TestUserSignInRememberSurvivesARestart(t *testing.T) {
	h := newUserAPITestHandler(t)
	if _, err := h.userSessions.restore(); err != nil {
		t.Fatal(err)
	}
	entry := addUsageKey(t, "kept", "sk-user-remember-0123456789", true)

	rec := userCall(h, http.MethodPost, "/user/api/session", "", `{"key":"`+entry.Key+`","remember":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	assertNear(t, "expiresAt", body.ExpiresAt, time.Now().Add(userRememberTTL).Unix(), 5)
	if got := savedSessionHashes(t, sessionKindUser); len(got) != 1 || got[0] != hashSessionToken(body.Token) {
		t.Fatalf("saved %v, want only the token's hash", got)
	}

	next := newHandlerWithoutBackgroundForTest(t)
	if _, err := next.userSessions.restore(); err != nil {
		t.Fatal(err)
	}
	if rec := userCall(next, http.MethodGet, "/user/api/key", body.Token, ""); rec.Code != http.StatusOK {
		t.Fatalf("restored session: %d %s", rec.Code, rec.Body.String())
	}

	if _, err := config.RegenerateApiKey(entry.ID); err != nil {
		t.Fatal(err)
	}
	if rec := userCall(next, http.MethodGet, "/user/api/key", body.Token, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("session after the key changed: %d, want 401", rec.Code)
	}
	if got := savedSessionHashes(t, sessionKindUser); len(got) != 0 {
		t.Fatalf("ended session left in the table: %v", got)
	}
}

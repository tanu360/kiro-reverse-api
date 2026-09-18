package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminSessionTokenLifecycle(t *testing.T) {
	store := newAdminSessionStore()

	token, expiry, err := store.Issue()
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if len(token) != 64 {
		t.Fatalf("token length %d, want 64 hex chars", len(token))
	}
	if !store.Valid(token) {
		t.Fatal("fresh token rejected")
	}
	if remaining := time.Until(expiry); remaining <= 0 || remaining > adminSessionTTL {
		t.Fatalf("expiry %v outside (0, %v]", remaining, adminSessionTTL)
	}

	if store.Valid("") || store.Valid("not-a-token") {
		t.Fatal("unknown token accepted")
	}

	store.Revoke(token)
	if store.Valid(token) {
		t.Fatal("revoked token still valid")
	}
}

func TestAdminSessionExpiryRejected(t *testing.T) {
	store := newAdminSessionStore()
	token, _, err := store.Issue()
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	store.mu.Lock()
	store.sessions[token] = time.Now().Add(-time.Second)
	store.mu.Unlock()

	if store.Valid(token) {
		t.Fatal("expired token accepted")
	}
	store.mu.Lock()
	_, present := store.sessions[token]
	store.mu.Unlock()
	if present {
		t.Fatal("expired token left in the store")
	}
}

// A password change must lock out everyone holding the old credential, so
// RevokeAll has to clear tickets as well as sessions.
func TestAdminSessionRevokeAllClearsTickets(t *testing.T) {
	store := newAdminSessionStore()
	token, _, err := store.Issue()
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	ticket, _, err := store.IssueTicket()
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	store.RevokeAll()

	if store.Valid(token) {
		t.Fatal("session survived RevokeAll")
	}
	if store.ConsumeTicket(ticket) {
		t.Fatal("ticket survived RevokeAll")
	}
}

// Tickets ride in a URL, where access logs and referrers keep them, so one must
// never work twice.
func TestAdminTicketIsSingleUse(t *testing.T) {
	store := newAdminSessionStore()
	ticket, expiry, err := store.IssueTicket()
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}
	if remaining := time.Until(expiry); remaining <= 0 || remaining > adminTicketTTL {
		t.Fatalf("expiry %v outside (0, %v]", remaining, adminTicketTTL)
	}

	if !store.ConsumeTicket(ticket) {
		t.Fatal("fresh ticket rejected")
	}
	if store.ConsumeTicket(ticket) {
		t.Fatal("ticket replayed")
	}
	if store.ConsumeTicket("") {
		t.Fatal("empty ticket accepted")
	}
}

func TestAdminTicketExpiryRejected(t *testing.T) {
	store := newAdminSessionStore()
	ticket, _, err := store.IssueTicket()
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	store.mu.Lock()
	store.tickets[ticket] = time.Now().Add(-time.Second)
	store.mu.Unlock()

	if store.ConsumeTicket(ticket) {
		t.Fatal("expired ticket accepted")
	}
}

// A login loop must not pin unbounded memory.
func TestAdminSessionsEvictOldest(t *testing.T) {
	store := newAdminSessionStore()
	first, _, err := store.Issue()
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	for i := 0; i < maxAdminSessions; i++ {
		if _, _, err := store.Issue(); err != nil {
			t.Fatalf("issue %d: %v", i, err)
		}
	}

	store.mu.Lock()
	count := len(store.sessions)
	store.mu.Unlock()
	if count > maxAdminSessions {
		t.Fatalf("stored %d sessions, cap is %d", count, maxAdminSessions)
	}
	if store.Valid(first) {
		t.Fatal("oldest session survived eviction")
	}
}

func TestAdminTokensAreDistinct(t *testing.T) {
	store := newAdminSessionStore()
	seen := make(map[string]bool)
	for i := 0; i < 64; i++ {
		token, _, err := store.Issue()
		if err != nil {
			t.Fatalf("issue %d: %v", i, err)
		}
		if seen[token] {
			t.Fatalf("token repeated after %d issues", i)
		}
		seen[token] = true
	}
}

func TestSecureCompare(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"secret", "secret", true},
		{"secret", "secrez", false},
		{"secret", "secre", false},
		{"", "", true},
		{"secret", "", false},
	} {
		if got := secureCompare(tc.a, tc.b); got != tc.want {
			t.Fatalf("secureCompare(%q, %q) = %v want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func newAdminAuthTestHandler(t *testing.T, password string) *Handler {
	t.Helper()
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	config.SetPassword(password)
	return newHandlerWithoutBackgroundForTest(t)
}

func adminStatusCode(h *Handler, req *http.Request) int {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

// The admin password used to be accepted from the query string, where server and
// proxy access logs keep it forever.
func TestAdminAPIRejectsPasswordInQueryString(t *testing.T) {
	const password = "admin-password"
	h := newAdminAuthTestHandler(t, password)

	for _, path := range []string{"/admin/api/status", "/admin/api/events"} {
		req := httptest.NewRequest(http.MethodGet, path+"?admin_password="+password, nil)
		if code := adminStatusCode(h, req); code != http.StatusUnauthorized {
			t.Fatalf("%s with password in query: got %d, want 401", path, code)
		}
	}
}

func TestAdminSessionEndpointIssuesUsableToken(t *testing.T) {
	const password = "admin-password"
	h := newAdminAuthTestHandler(t, password)

	loginRec := httptest.NewRecorder()
	h.ServeHTTP(loginRec, httptest.NewRequest(http.MethodPost, "/admin/api/session",
		strings.NewReader(`{"password":"`+password+`"}`)))
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginRec.Code, loginRec.Body.String())
	}
	var issued struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &issued); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if issued.Token == "" || issued.ExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("unusable session: %+v", issued)
	}

	authed := httptest.NewRequest(http.MethodGet, "/admin/api/status", nil)
	authed.Header.Set("X-Admin-Token", issued.Token)
	if code := adminStatusCode(h, authed); code != http.StatusOK {
		t.Fatalf("token auth: got %d, want 200", code)
	}

	wrong := httptest.NewRecorder()
	h.ServeHTTP(wrong, httptest.NewRequest(http.MethodPost, "/admin/api/session",
		strings.NewReader(`{"password":"wrong"}`)))
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d, want 401", wrong.Code)
	}
}

// A ticket authenticates the event stream only. Anywhere else it must be worthless.
func TestAdminTicketAuthorizesEventsOnly(t *testing.T) {
	h := newAdminAuthTestHandler(t, "admin-password")
	ticket, _, err := h.adminSessions.IssueTicket()
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/api/accounts?ticket="+ticket, nil)
	if code := adminStatusCode(h, req); code != http.StatusUnauthorized {
		t.Fatalf("ticket on /accounts: got %d, want 401", code)
	}
	if !h.adminSessions.ConsumeTicket(ticket) {
		t.Fatal("a rejected route burned the ticket")
	}
}

// The admin API carries account credentials, so no origin may read it cross-site.
func TestCORSWildcardSkipsAdminPaths(t *testing.T) {
	h := newAdminAuthTestHandler(t, "admin-password")

	adminRec := httptest.NewRecorder()
	h.ServeHTTP(adminRec, httptest.NewRequest(http.MethodGet, "/admin/api/status", nil))
	if origin := adminRec.Header().Get("Access-Control-Allow-Origin"); origin != "" {
		t.Fatalf("admin path exposed CORS origin %q", origin)
	}

	apiRec := httptest.NewRecorder()
	h.ServeHTTP(apiRec, httptest.NewRequest(http.MethodOptions, "/v1/messages", nil))
	if origin := apiRec.Header().Get("Access-Control-Allow-Origin"); origin != "*" {
		t.Fatalf("inference path CORS origin %q, want *", origin)
	}
}

package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func firstRunPassword(t *testing.T, h *Handler) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/api/first-run", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("first-run: got %d", rec.Code)
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Password
}

func signIn(h *Handler, password string) int {
	req := httptest.NewRequest(http.MethodPost, "/admin/api/session", strings.NewReader(`{"password":"`+password+`"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestFirstRunPasswordShownUntilFirstSignIn(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler()

	shown := firstRunPassword(t, h)
	if shown == "" || shown != config.GetPassword() {
		t.Fatalf("login page did not show the generated password: %q", shown)
	}
	if !regexp.MustCompile(`^[0-9]{8}$`).MatchString(shown) {
		t.Fatal("first-run endpoint must return an eight-digit password")
	}

	//! A restart before anyone signs in must not lose the only copy the owner can see.
	if err := config.Load(); err != nil {
		t.Fatal(err)
	}
	if firstRunPassword(t, h) != shown {
		t.Fatal("password disappeared after a restart without a sign-in")
	}

	if code := signIn(h, "wrong-password"); code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d", code)
	}
	if firstRunPassword(t, h) != shown {
		t.Fatal("a failed sign-in hid the password")
	}

	if code := signIn(h, shown); code != http.StatusOK {
		t.Fatalf("sign-in with generated password: got %d", code)
	}
	if got := firstRunPassword(t, h); got != "" {
		t.Fatalf("password still public after first sign-in: %q", got)
	}
	if err := config.Load(); err != nil {
		t.Fatal(err)
	}
	if got := firstRunPassword(t, h); got != "" {
		t.Fatalf("password came back after a restart: %q", got)
	}
}

func TestFirstRunPasswordNeverShownForChosenPassword(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "operator-chosen")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	if got := firstRunPassword(t, NewHandler()); got != "" {
		t.Fatalf("an ADMIN_PASSWORD value was shown on the login page: %q", got)
	}
}

func TestFirstRunPasswordHiddenAfterEnvOverride(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	//! main applies ADMIN_PASSWORD after Load; the page must not then show that value.
	config.SetPassword("operator-chosen")
	if got := firstRunPassword(t, NewHandler()); got != "" {
		t.Fatalf("an ADMIN_PASSWORD override was shown on the login page: %q", got)
	}
}

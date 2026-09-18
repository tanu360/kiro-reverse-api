package proxy

import (
	"fmt"
	"kiro-proxy/config"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminPasswordLimitsCoverBothRoutes(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("00001122")
	h := &Handler{adminSessions: newAdminSessionStore()}
	for i := 0; i < adminGuessesPerClient+2; i++ {
		req := httptest.NewRequest("GET", "/admin/api/status", nil)
		req.RemoteAddr = fmt.Sprintf("192.0.2.1:%d", 1000+i)
		req.Header.Set("X-Admin-Password", "wrong")
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		if i%2 == 0 {
			req = httptest.NewRequest("POST", "/admin/api/session", strings.NewReader(`{"password":"wrong"}`))
			req.RemoteAddr = fmt.Sprintf("192.0.2.1:%d", 1000+i)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := 401
		if i >= adminGuessesPerClient {
			want = 429
		}
		if rec.Code != want {
			t.Fatalf("attempt=%d status=%d", i, rec.Code)
		}
		if want == 429 && rec.Header().Get("Retry-After") == "" {
			t.Fatal("missing retry hint")
		}
	}
	token, _, err := h.adminSessions.Issue()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/admin/api/settings", nil)
	req.RemoteAddr = "192.0.2.1:9999"
	req.Header.Set("X-Admin-Token", token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("existing session throttled: %d", rec.Code)
	}
}
func TestAdminLimiterGlobalAndExpiry(t *testing.T) {
	var l adminGuessLimiter
	now := time.Now()
	for i := 0; i < adminGuessesGlobal; i++ {
		if l.allow(fmt.Sprint(i), now) != 0 {
			t.Fatal("early global limit")
		}
	}
	if l.allow("new", now) == 0 {
		t.Fatal("distributed guesses not limited")
	}
	if l.allow("new", now.Add(adminGuessWindow)) != 0 {
		t.Fatal("window did not expire")
	}
}

func TestSuccessfulPasswordChecksDoNotConsumeFailureBudget(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("12345678")
	var limiter adminGuessLimiter
	for i := 0; i < 100; i++ {
		valid, delay := limiter.checkPassword("192.0.2.1", "12345678", time.Now())
		if !valid || delay != 0 {
			t.Fatal("valid credentials throttled")
		}
	}
}

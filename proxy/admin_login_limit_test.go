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
func TestAdminLimiterSlowsDistributedGuessesWithoutLockout(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("12345678")
	var l adminGuessLimiter
	now := time.Now()
	for i := 0; i < adminGuessesGlobal; i++ {
		if l.allow(fmt.Sprint(i), now) != 0 {
			t.Fatal("early global limit")
		}
	}
	for i := 0; i < adminGuessesUnderAttack; i++ {
		if l.allow("attacker", now) != 0 {
			t.Fatal("fresh client locked out during attack")
		}
	}
	if l.allow("attacker", now) == 0 {
		t.Fatal("distributed guesses not slowed")
	}
	if valid, delay := l.checkPassword("admin", "12345678", now); !valid || delay != 0 {
		t.Fatalf("real admin locked out: valid=%v delay=%s", valid, delay)
	}
	if l.allow("attacker", now.Add(adminGuessWindow)) != 0 {
		t.Fatal("window did not expire")
	}
}

func TestAdminLimiterGroupsIPv6ByPrefix(t *testing.T) {
	key := func(addr string) string {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = addr
		return adminRemoteHost(req)
	}
	if key("[2001:db8:1:2::1]:1000") != key("[2001:db8:1:2:ffff::9]:2000") {
		t.Fatal("addresses in one /64 must share a bucket")
	}
	if key("[2001:db8:1:2::1]:1000") == key("[2001:db8:1:3::1]:1000") {
		t.Fatal("different /64 prefixes must not share a bucket")
	}
	if got := key("[::ffff:192.0.2.1]:1000"); got != "192.0.2.1" {
		t.Fatalf("IPv4-mapped address keyed as %q", got)
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

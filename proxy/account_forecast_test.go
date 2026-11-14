package proxy

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestForecastAccountStates(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	day := int64(86400)
	reset := now.Unix() + 10*day
	acc := func(used, limit float64) config.Account {
		return config.Account{ID: "f", UsageCurrent: used, UsageLimit: limit, NextResetAt: reset, NextResetDate: "2030-03-27"}
	}
	week := accountSpend{credits: 70, firstTS: now.Unix() - 7*day}

	// 10 credits a day, 50 left, reset in 10 days: runs out in 5.
	f := forecastAccount(acc(450, 500), week, 0, now)
	if f.Status != forecastRunsOut || f.BurnPerDay != 10 || f.Remaining != 50 || f.DepletesAt != now.Unix()+5*day || f.LeftAtReset != 0 {
		t.Fatalf("runs out: %+v", f)
	}
	// 300 left lasts past the reset with 200 to spare.
	f = forecastAccount(acc(200, 500), week, 0, now)
	if f.Status != forecastLasts || math.Abs(f.LeftAtReset-200) > 1e-9 || f.DepletesAt != now.Unix()+30*day {
		t.Fatalf("lasts: %+v", f)
	}
	// Spend since the last refresh counts: 300 - 260 = 40 left, gone in 4 days.
	if f = forecastAccount(acc(200, 500), week, 260, now); f.Status != forecastRunsOut || f.Remaining != 40 {
		t.Fatalf("local spend: %+v", f)
	}
	if f = forecastAccount(acc(500, 500), week, 0, now); f.Status != forecastEmpty {
		t.Fatalf("empty: %+v", f)
	}
	if f = forecastAccount(acc(100, 500), accountSpend{}, 0, now); f.Status != forecastIdle || f.LeftAtReset != 400 || f.DepletesAt != 0 {
		t.Fatalf("idle: %+v", f)
	}
	if f = forecastAccount(config.Account{ID: "f"}, week, 0, now); f.Status != forecastUnknown {
		t.Fatalf("no limit: %+v", f)
	}
	// An account first used two days ago averages over two days, not seven.
	young := accountSpend{credits: 40, firstTS: now.Unix() - 2*day}
	if f = forecastAccount(acc(0, 500), young, 0, now); f.BurnPerDay != 20 || f.SpanDays != 2 {
		t.Fatalf("young account: %+v", f)
	}
	// One used an hour ago still averages over a whole day.
	fresh := accountSpend{credits: 5, firstTS: now.Unix() - 3600}
	if f = forecastAccount(acc(0, 500), fresh, 0, now); f.SpanDays != 1 || f.BurnPerDay != 5 {
		t.Fatalf("fresh account: %+v", f)
	}
	// A reset moment already past (a refresh that has not caught up) compares with nothing.
	stale := acc(450, 500)
	stale.NextResetAt = now.Unix() - day
	if f = forecastAccount(stale, week, 0, now); f.Status != forecastUnknown || f.ResetAt != 0 || f.DepletesAt == 0 {
		t.Fatalf("stale reset: %+v", f)
	}
}

func TestAccountForecastEndpointReadsTheRequestLog(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "fc-a", "fc-b")
	if err := config.UpdateAccountInfo("fc-a", config.AccountInfo{UsageCurrent: 450, UsageLimit: 500, NextResetAt: time.Now().Add(20 * 24 * time.Hour).Unix(), NextResetDate: "2099-01-01"}); err != nil {
		t.Fatal(err)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	for i, credits := range []float64{30, 40} {
		if _, err := d.Exec(`INSERT INTO requests (ts, account_id, credits, success) VALUES (?, 'fc-a', ?, 1)`, now-int64(i+1)*86400*3, credits); err != nil {
			t.Fatal(err)
		}
	}
	// Outside the window: never counted.
	if _, err := d.Exec(`INSERT INTO requests (ts, account_id, credits, success) VALUES (?, 'fc-a', 999, 1)`, now-30*86400); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminRequestForTest(t, h, http.MethodGet, "/admin/api/accounts/forecast"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var resp accountForecastResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	a := resp.Forecasts["fc-a"]
	if resp.WindowDays != 7 || a.Spent != 70 || a.Status != forecastRunsOut || a.Remaining != 50 {
		t.Fatalf("fc-a = %+v (window %d)", a, resp.WindowDays)
	}
	if b := resp.Forecasts["fc-b"]; b.Status != forecastUnknown || b.Spent != 0 {
		t.Fatalf("fc-b = %+v", b)
	}
}

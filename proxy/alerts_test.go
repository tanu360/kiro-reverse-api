package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func initAlertsTest(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := config.Init(path); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	return path
}

func testAlertsConfig() config.AlertsConfig {
	return config.AlertsConfig{
		AccountThresholds:   []int{80, 90, 100},
		PoolThresholds:      []int{80, 90, 100},
		PoolCooldownMinutes: 60,
		Channels: []config.AlertChannel{
			{ID: "ch_1", Type: config.AlertChannelWebhook, Name: "hook", Enabled: true, URL: "http://127.0.0.1:1/hook"},
		},
	}
}

func usageAccount(id string, used, limit float64, period string) config.Account {
	return config.Account{ID: id, Email: id + "@example.test", Enabled: true, UsageCurrent: used, UsageLimit: limit, NextResetDate: period}
}

func eventsOf(msgs []alertMessage) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.Event)
	}
	return out
}

func mustEvaluate(t *testing.T, a *alerter, cfg config.AlertsConfig, accounts []config.Account, pooled, available int, now int64) ([]alertMessage, time.Duration) {
	t.Helper()
	msgs, wait, err := a.evaluate(cfg, accounts, pooled, available, now)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	return msgs, wait
}

// usageOnly switches every rule but the one under test off.
func usageOnly(cfg config.AlertsConfig, rule string) config.AlertsConfig {
	off, on := false, true
	cfg.AccountUsage, cfg.PoolUsage, cfg.AccountBanned, cfg.AllUnavailable = &off, &off, &off, &off
	switch rule {
	case alertEventAccountUsage:
		cfg.AccountUsage = &on
	case alertEventPoolUsage:
		cfg.PoolUsage = &on
	case alertEventAccountBanned:
		cfg.AccountBanned = &on
	case alertEventAllUnavailable:
		cfg.AllUnavailable = &on
	}
	return cfg
}

func TestHighestCrossedThreshold(t *testing.T) {
	th := []int{80, 90, 100}
	for _, tc := range []struct {
		pct  float64
		want int
	}{
		{0, 0}, {79.9, 0}, {80, 80}, {89.99999999999, 90}, {95, 90}, {100, 100}, {150, 100},
	} {
		if got := highestCrossed(th, tc.pct); got != tc.want {
			t.Errorf("highestCrossed(%v) = %d, want %d", tc.pct, got, tc.want)
		}
	}
}

func TestAccountAlertSendsHighestCrossedOnce(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountUsage)
	const now = int64(1_800_000_000)

	//! First seen at 95 %: one message for 90 %, not one each for 80 and 90.
	msgs, _ := mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 95, 100, "2026-12-01")}, 1, 1, now)
	if len(msgs) != 1 || msgs[0].Data["threshold"] != 90 || msgs[0].Event != alertEventAccountUsage {
		t.Fatalf("first = %+v", msgs)
	}
	msgs, _ = mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 97, 100, "2026-12-01")}, 1, 1, now+60)
	if len(msgs) != 0 {
		t.Fatalf("repeat sent %+v", msgs)
	}
	msgs, _ = mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 100, 100, "2026-12-01")}, 1, 1, now+120)
	if len(msgs) != 1 || msgs[0].Data["threshold"] != 100 || msgs[0].Severity != "critical" {
		t.Fatalf("100 %% = %+v", msgs)
	}
	msgs, _ = mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 100, 100, "2026-12-01")}, 1, 1, now+180)
	if len(msgs) != 0 {
		t.Fatalf("repeat at 100 %% sent %+v", msgs)
	}
	//! Accounts the pool does not use stay quiet.
	disabled := usageAccount("a2", 99, 100, "2026-12-01")
	disabled.Enabled = false
	silent := usageAccount("a3", 99, 100, "2026-12-01")
	silent.Silent = true
	msgs, _ = mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 100, 100, "2026-12-01"), disabled, silent}, 2, 1, now+240)
	if len(msgs) != 0 {
		t.Fatalf("ineligible accounts alerted: %+v", msgs)
	}
}

func TestAccountAlertDedupSurvivesRestart(t *testing.T) {
	path := initAlertsTest(t)
	cfg := usageOnly(testAlertsConfig(), alertEventAccountUsage)
	accounts := []config.Account{usageAccount("a1", 85, 100, "2026-12-01")}
	if msgs, _ := mustEvaluate(t, newAlerter(), cfg, accounts, 1, 1, 1000); len(msgs) != 1 {
		t.Fatalf("first = %+v", msgs)
	}
	// A restart: the database is closed and opened again, the alerter is new.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := config.Init(path); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := mustEvaluate(t, newAlerter(), cfg, accounts, 1, 1, 2000); len(msgs) != 0 {
		t.Fatalf("resent after restart: %+v", msgs)
	}
}

func TestAccountAlertRearmsOnNewPeriod(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountUsage)
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 85, 100, "2026-12-01")}, 1, 1, 1000); len(msgs) != 1 {
		t.Fatalf("first = %+v", msgs)
	}
	// The quota reset: a new period at low usage re-arms without a message.
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 5, 100, "2027-01-01")}, 1, 1, 2000); len(msgs) != 0 {
		t.Fatalf("reset sent %+v", msgs)
	}
	msgs, _ := mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 82, 100, "2027-01-01")}, 1, 1, 3000)
	if len(msgs) != 1 || msgs[0].Data["threshold"] != 80 {
		t.Fatalf("new period = %+v", msgs)
	}
}

func TestAccountAlertRearmsWhenUsageDrops(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountUsage)
	steps := []struct {
		used float64
		want int
	}{{95, 90}, {50, 0}, {92, 90}, {92, 0}}
	for i, step := range steps {
		msgs, _ := mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", step.used, 100, "")}, 1, 1, int64(1000+i))
		got := 0
		if len(msgs) == 1 {
			got = msgs[0].Data["threshold"].(int)
		}
		if len(msgs) > 1 || got != step.want {
			t.Fatalf("step %d (%v%%) = %+v, want %d", i, step.used, msgs, step.want)
		}
	}
}

func TestPoolAlertCooldownAndRearm(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventPoolUsage)
	const t0 = int64(1_800_000_000)
	pool := func(pct float64) []config.Account {
		return []config.Account{usageAccount("a1", pct, 100, ""), usageAccount("a2", pct, 100, "")}
	}
	steps := []struct {
		at   int64
		pct  float64
		want int
	}{
		{t0, 85, 80},
		{t0 + 10*60, 95, 0},  // inside the 60 min cooldown
		{t0 + 61*60, 95, 90}, // cooldown over: the highest crossed
		{t0 + 70*60, 50, 0},  // drop re-arms
		{t0 + 75*60, 85, 0},  // re-armed, but the last message was 14 min ago
		{t0 + 122*60, 85, 80},
		{t0 + 200*60, 85, 0}, // already notified for 80
	}
	for i, step := range steps {
		msgs, _ := mustEvaluate(t, a, cfg, pool(step.pct), 2, 2, step.at)
		got := 0
		if len(msgs) == 1 {
			got = msgs[0].Data["threshold"].(int)
			if msgs[0].Event != alertEventPoolUsage || msgs[0].Data["accounts"] != 2 {
				t.Fatalf("step %d message = %+v", i, msgs[0])
			}
		}
		if len(msgs) > 1 || got != step.want {
			t.Fatalf("step %d = %+v, want %d", i, msgs, step.want)
		}
	}
}

func TestPoolUsageCountsOnlyEligibleAccounts(t *testing.T) {
	disabled := usageAccount("d", 100, 100, "")
	disabled.Enabled = false
	silent := usageAccount("s", 100, 100, "")
	silent.Silent = true
	banned := usageAccount("b", 100, 100, "")
	banned.BanStatus = "BANNED"
	suspended := usageAccount("x", 100, 100, "")
	suspended.BanStatus = "DISABLED"
	active := usageAccount("ok2", 10, 100, "")
	active.BanStatus = "ACTIVE"
	noLimit := usageAccount("n", 5, 0, "")
	used, limit, n := poolUsage([]config.Account{usageAccount("ok", 50, 100, ""), active, disabled, silent, banned, suspended, noLimit})
	if used != 60 || limit != 200 || n != 2 {
		t.Fatalf("poolUsage = %v / %v over %d", used, limit, n)
	}
}

func TestBannedAlertOncePerBan(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountBanned)
	const now = int64(1_800_000_000)
	acc := config.Account{ID: "a1", Email: "a1@example.test", BanStatus: "BANNED", BanReason: "AWS temporarily suspended", BanTime: now - 60}
	msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, now)
	if len(msgs) != 1 || msgs[0].Event != alertEventAccountBanned || msgs[0].Data["reason"] != "AWS temporarily suspended" {
		t.Fatalf("ban = %+v", msgs)
	}
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, now+60); len(msgs) != 0 {
		t.Fatalf("same ban resent: %+v", msgs)
	}
	//! DISABLED is a manual switch-off: no alert.
	manual := config.Account{ID: "a2", BanStatus: "DISABLED", BanTime: now}
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc, manual}, 0, 0, now+90); len(msgs) != 0 {
		t.Fatalf("manual disable alerted: %+v", msgs)
	}
	// Unbanned, served a request, then banned again later: a new ban, a new message.
	acc.BanTime = now + 600
	acc.RequestCount = 1
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, now+620); len(msgs) != 1 {
		t.Fatalf("second ban = %+v", msgs)
	}
}

func TestBannedAlertNotRepeatedWhenAHealedAccountFailsAgain(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountBanned)
	const now = int64(1_800_000_000)
	acc := config.Account{ID: "a1", Email: "a1@example.test", BanStatus: "BANNED", BanReason: banReasonAuthFailed,
		BanTime: now - 60, RequestCount: 5, ErrorCount: 1}
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, now); len(msgs) != 1 {
		t.Fatalf("first ban = %+v", msgs)
	}
	// Five self-heal rounds: re-enabled (BanTime 0), the next request fails and bans it again.
	for round := int64(1); round <= 5; round++ {
		at := now + round*300
		healed := acc
		healed.Enabled, healed.BanStatus, healed.BanReason, healed.BanTime = true, "ACTIVE", "", 0
		if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{healed}, 1, 1, at); len(msgs) != 0 {
			t.Fatalf("round %d heal alerted: %+v", round, msgs)
		}
		acc.BanTime = at + 5
		acc.RequestCount++
		acc.ErrorCount++
		if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, at+10); len(msgs) != 0 {
			t.Fatalf("round %d re-ban alerted again: %+v", round, msgs)
		}
	}
	// A restart reads the same state.
	if msgs, _ := mustEvaluate(t, newAlerter(), cfg, []config.Account{acc}, 0, 0, now+2000); len(msgs) != 0 {
		t.Fatalf("restart resent: %+v", msgs)
	}
	// Another reason is news.
	acc.BanReason = "AWS temporarily suspended"
	acc.BanTime = now + 2100
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{acc}, 0, 0, now+2110); len(msgs) != 1 {
		t.Fatalf("a new reason = %+v", msgs)
	}
}

func TestBannedAlertReadsAStateRowFromBeforeTheServedCount(t *testing.T) {
	const now = int64(1_800_000_000)
	acc := config.Account{ID: "a1", BanStatus: "BANNED", BanReason: "x", BanTime: now - 60}
	legacy := alertState{Period: strconv.FormatInt(acc.BanTime, 10), Level: 1, SentAt: now - 50}
	if send, next := evalBanned(acc, legacy, now); send || next.SentAt != legacy.SentAt || next.Period != banPeriod(acc.BanTime, 0, "x") {
		t.Fatalf("the same ban resent or lost its send time: send=%v next=%+v", send, next)
	}
	acc.BanTime = now - 30
	if send, _ := evalBanned(acc, legacy, now); !send {
		t.Fatal("a later ban after an old-format row did not alert")
	}
}

func TestBannedAlertSkipsStaleBans(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountBanned)
	const now = int64(1_800_000_000)
	old := config.Account{ID: "a1", BanStatus: "BANNED", BanTime: now - 2*3600}
	if msgs, _ := mustEvaluate(t, a, cfg, []config.Account{old}, 0, 0, now); len(msgs) != 0 {
		t.Fatalf("stale ban alerted: %+v", msgs)
	}
	states, err := loadAlertStates()
	if err != nil {
		t.Fatal(err)
	}
	if st := states[alertKeyBannedPrefix+"a1"]; st.Period == "" || st.SentAt != 0 {
		t.Fatalf("stale ban not recorded: %+v", st)
	}
}

func TestAllUnavailableAlertGraceAndRearm(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAllUnavailable)
	const t0 = int64(1_800_000_000)
	steps := []struct {
		at                int64
		pooled, available int
		send              bool
		wait              time.Duration
	}{
		{t0, 3, 0, false, 60 * time.Second}, // grace starts
		{t0 + 30, 3, 0, false, 30 * time.Second},
		{t0 + 60, 3, 0, true, 0},
		{t0 + 120, 3, 0, false, 0}, // once per outage
		{t0 + 130, 3, 1, false, 0}, // recovered: re-arms
		{t0 + 200, 3, 0, false, 60 * time.Second},
		{t0 + 260, 3, 0, false, 0},      // a second outage inside the cooldown
		{t0 + 60 + 3600, 3, 0, true, 0}, // cooldown over, still down
		{t0 + 9000, 0, 0, false, 0},     // every account switched off: an admin choice, not an outage
		{t0 + 9100, 3, 0, false, 60 * time.Second},
	}
	for i, step := range steps {
		msgs, wait := mustEvaluate(t, a, cfg, nil, step.pooled, step.available, step.at)
		if (len(msgs) == 1) != step.send || len(msgs) > 1 || wait != step.wait {
			t.Fatalf("step %d: msgs=%+v wait=%v, want send=%v wait=%v", i, eventsOf(msgs), wait, step.send, step.wait)
		}
	}
}

func TestAllUnavailableAlertWhenBansEmptyThePool(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAllUnavailable)
	const t0 = int64(1_800_000_000)
	//! Every ban path also switches the account off (Enabled=false).
	banned := func(id string) config.Account {
		return config.Account{ID: id, BanStatus: "BANNED", BanReason: "AWS temporarily suspended", BanTime: t0 - 7200}
	}
	manual := config.Account{ID: "off", BanStatus: "DISABLED", BanTime: t0 - 7200}
	accounts := []config.Account{banned("a1"), banned("a2"), banned("a3"), manual}

	enabled, available := accountAvailability(accounts, false, nil)
	if enabled != 0 || available != 0 {
		t.Fatalf("availability = %d enabled, %d available", enabled, available)
	}
	pooled := alertPoolSize(accounts)
	if pooled != 3 {
		t.Fatalf("pool size = %d, want 3 (the banned accounts, not the one switched off)", pooled)
	}
	if msgs, wait := mustEvaluate(t, a, cfg, accounts, pooled, available, t0); len(msgs) != 0 || wait != alertUnavailableGrace {
		t.Fatalf("grace: msgs=%v wait=%v", eventsOf(msgs), wait)
	}
	msgs, _ := mustEvaluate(t, a, cfg, accounts, pooled, available, t0+60)
	if len(msgs) != 1 || msgs[0].Event != alertEventAllUnavailable || msgs[0].Data["accounts"] != 3 {
		t.Fatalf("outage = %+v", msgs)
	}
	//! Only accounts the admin switched off: no outage.
	if n := alertPoolSize([]config.Account{manual}); n != 0 {
		t.Fatalf("pool size of a switched-off pool = %d", n)
	}
}

func TestNoEvaluationWithoutEnabledChannel(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := testAlertsConfig()
	cfg.Channels[0].Enabled = false
	now := int64(1_800_000_000)
	accounts := []config.Account{
		usageAccount("a1", 100, 100, ""),
		{ID: "a2", BanStatus: "BANNED", BanTime: now - 10},
	}
	msgs, wait := mustEvaluate(t, a, cfg, accounts, 3, 0, now)
	if len(msgs) != 0 || wait != 0 {
		t.Fatalf("msgs=%+v wait=%v", msgs, wait)
	}
	states, err := loadAlertStates()
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 0 {
		t.Fatalf("state used up without a channel: %+v", states)
	}
	//! Once a channel is on, the same situation alerts: nothing was spent while it was off.
	cfg.Channels[0].Enabled = true
	msgs, _ = mustEvaluate(t, a, cfg, accounts, 3, 0, now)
	if len(msgs) != 3 {
		t.Fatalf("with a channel = %v", eventsOf(msgs))
	}
}

func TestAlertStatePrunedForDeletedAccounts(t *testing.T) {
	initAlertsTest(t)
	a := newAlerter()
	cfg := usageOnly(testAlertsConfig(), alertEventAccountUsage)
	mustEvaluate(t, a, cfg, []config.Account{usageAccount("a1", 85, 100, ""), usageAccount("a2", 85, 100, "")}, 2, 2, 1000)
	mustEvaluate(t, a, cfg, []config.Account{usageAccount("a2", 85, 100, "")}, 1, 1, 2000)
	states, err := loadAlertStates()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := states[alertKeyAccountPrefix+"a1"]; ok {
		t.Fatalf("deleted account's row kept: %+v", states)
	}
	if _, ok := states[alertKeyAccountPrefix+"a2"]; !ok {
		t.Fatalf("live account's row dropped: %+v", states)
	}
}

func TestAlertSenderDeliversToEveryEnabledChannel(t *testing.T) {
	initAlertsTest(t)
	var mu sync.Mutex
	got := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg alertMessage
		_ = json.Unmarshal(body, &msg)
		mu.Lock()
		got[r.URL.Path] = msg.Event
		mu.Unlock()
	}))
	defer srv.Close()
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.Channels = []config.AlertChannel{
			{ID: "ch_a", Type: config.AlertChannelWebhook, Enabled: true, URL: srv.URL + "/a"},
			{ID: "ch_b", Type: config.AlertChannelWebhook, Enabled: true, URL: srv.URL + "/b"},
			{ID: "ch_off", Type: config.AlertChannelWebhook, Enabled: false, URL: srv.URL + "/off"},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	a := newAlerter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.run(ctx, alertHTTPClient)
	a.enqueue([]alertMessage{poolUsageMessage(90, 100, 1, 90, 1000)})

	deadline := time.Now().Add(5 * time.Second)
	for {
		deliveries, err := loadAlertDeliveries()
		if err != nil {
			t.Fatal(err)
		}
		if len(deliveries) == 2 && deliveries["ch_a"].OK && deliveries["ch_b"].OK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("deliveries = %+v", deliveries)
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got["/a"] != alertEventPoolUsage || got["/b"] != alertEventPoolUsage || got["/off"] != "" {
		t.Fatalf("received = %v", got)
	}
}

func TestAlertBurstReachesEveryChannelInOrder(t *testing.T) {
	initAlertsTest(t)
	srv, received := alertReceiver(t)
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.Channels = []config.AlertChannel{{ID: "ch_burst", Type: config.AlertChannelWebhook, Enabled: true, URL: srv.URL + "/hook"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	//! More messages than one evaluation used to fit in the queue (32): none may be lost.
	const n = 80
	msgs := make([]alertMessage, n)
	for i := range msgs {
		msgs[i] = accountUsageMessage(usageAccount(fmt.Sprintf("a%02d", i), 90, 100, ""), 90, 1000)
	}
	a := newAlerter()
	a.enqueue(msgs)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.run(ctx, alertHTTPClient)

	deadline := time.Now().Add(10 * time.Second)
	for len(received()) < n {
		if time.Now().After(deadline) {
			t.Fatalf("received %d of %d", len(received()), n)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for i, got := range received() {
		var msg alertMessage
		if err := json.Unmarshal(got.body, &msg); err != nil || msg.Data["accountId"] != fmt.Sprintf("a%02d", i) {
			t.Fatalf("message %d = %s (%v)", i, got.body, err)
		}
	}
}

func TestSlowAlertChannelDoesNotHoldOthers(t *testing.T) {
	initAlertsTest(t)
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	defer close(release)
	fast, received := alertReceiver(t)
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.Channels = []config.AlertChannel{
			{ID: "ch_slow", Type: config.AlertChannelWebhook, Enabled: true, URL: slow.URL + "/hook"},
			{ID: "ch_fast", Type: config.AlertChannelWebhook, Enabled: true, URL: fast.URL + "/hook"},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	a := newAlerter()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.run(ctx, alertHTTPClient)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	a.enqueue([]alertMessage{poolUsageMessage(80, 100, 1, 80, 1000), poolUsageMessage(90, 100, 1, 90, 1001), poolUsageMessage(100, 100, 1, 100, 1002)})

	//! The slow channel is stuck on its first message for the whole 10 s attempt timeout.
	deadline := time.Now().Add(3 * time.Second)
	for len(received()) < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("the healthy channel got %d of 3 while the other one hung", len(received()))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAlertOutboxDropsOnlyItsOldest(t *testing.T) {
	initAlertsTest(t)
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.Channels = []config.AlertChannel{{ID: "ch_dead", Type: config.AlertChannelWebhook, Enabled: true, URL: "http://127.0.0.1:1/hook"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	a := newAlerter()
	for i := range alertOutboxLimit + 5 {
		a.enqueue([]alertMessage{{Event: alertEventPoolUsage, TS: int64(i)}})
	}
	box := a.outboxes["ch_dead"]
	if box == nil || len(box.msgs) != alertOutboxLimit || box.msgs[0].TS != 5 || box.msgs[alertOutboxLimit-1].TS != alertOutboxLimit+4 {
		t.Fatalf("outbox = %d messages", len(box.msgs))
	}
}

func TestBackgroundAlertsEvaluatesAfterAccountChange(t *testing.T) {
	initAlertsTest(t)
	srv, received := alertReceiver(t)
	off := false
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.PoolUsage, c.AllUnavailable = &off, &off
		c.Channels = []config.AlertChannel{{ID: "ch_bg", Type: config.AlertChannelWebhook, Enabled: true, URL: srv.URL + "/hook"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	h := &Handler{stopRefresh: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		h.backgroundAlerts()
		close(done)
	}()
	defer func() {
		close(h.stopRefresh)
		<-done
	}()
	// Let the loop subscribe before the change is published.
	time.Sleep(50 * time.Millisecond)

	//! The account write publishes accounts_changed; the alerter evaluates after the debounce.
	if err := config.AddAccount(usageAccount("bg1", 91, 100, "2026-12-01")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(alertDebounceQuiet + 5*time.Second)
	for len(received()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no alert after the account change")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var msg alertMessage
	if err := json.Unmarshal(received()[0].body, &msg); err != nil || msg.Event != alertEventAccountUsage || msg.Data["threshold"] != float64(90) {
		t.Fatalf("message = %s (%v)", received()[0].body, err)
	}
}

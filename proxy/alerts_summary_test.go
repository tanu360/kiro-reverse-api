package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestDailySummarySlotAndDue(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	minute := 9*60 + 30 // 09:30 UTC
	if got := dailySummarySlot(at("2026-11-14T10:00:00Z"), minute); !got.Equal(at("2026-11-14T09:30:00Z")) {
		t.Fatalf("slot after today's = %v", got)
	}
	if got := dailySummarySlot(at("2026-11-14T08:00:00Z"), minute); !got.Equal(at("2026-11-13T09:30:00Z")) {
		t.Fatalf("slot before today's = %v", got)
	}
	// A time zone does not move the slot: it is UTC.
	local := at("2026-11-14T10:00:00Z").In(time.FixedZone("UTC+5:30", 5*3600+1800))
	if got := dailySummarySlot(local, minute); !got.Equal(at("2026-11-14T09:30:00Z")) {
		t.Fatalf("slot from a +05:30 clock = %v", got)
	}
	if _, due := dailySummaryDue(at("2026-11-14T09:31:00Z"), minute, alertState{}); !due {
		t.Fatal("a fresh slot is not due")
	}
	if _, due := dailySummaryDue(at("2026-11-14T09:31:00Z"), minute, alertState{Period: "2026-11-14"}); due {
		t.Fatal("a slot already sent is due again")
	}
	if _, due := dailySummaryDue(at("2026-11-14T12:31:00Z"), minute, alertState{Period: "2026-11-13"}); due {
		t.Fatal("a slot more than the grace old still goes out")
	}
	if _, due := dailySummaryDue(at("2026-11-14T12:29:00Z"), minute, alertState{Period: "2026-11-13"}); !due {
		t.Fatal("a slot missed by a restart within the grace does not go out")
	}
	if got := untilNextDailySummary(at("2026-11-14T09:30:00Z"), minute); got != 24*time.Hour {
		t.Fatalf("until next at the slot = %v", got)
	}
	if got := untilNextDailySummary(at("2026-11-14T09:00:00Z"), minute); got != 30*time.Minute {
		t.Fatalf("until next half an hour before = %v", got)
	}
}

// summaryReceiver is a webhook that keeps every alert it gets.
type summaryReceiver struct {
	mu   sync.Mutex
	msgs []alertMessage
}

func (s *summaryReceiver) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg alertMessage
		if err := json.Unmarshal(body, &msg); err != nil {
			t.Errorf("decode alert: %v", err)
		}
		s.mu.Lock()
		s.msgs = append(s.msgs, msg)
		s.mu.Unlock()
	}
}

func (s *summaryReceiver) list() []alertMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]alertMessage(nil), s.msgs...)
}

func seedSummaryTraffic(t *testing.T, now time.Time) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	rows := []struct {
		ago      time.Duration
		account  string
		key      string
		credits  float64
		success  int
		in, outT int
	}{
		{time.Hour, "sum-a", "key-1", 1.5, 1, 1000, 200},
		{2 * time.Hour, "sum-a", "key-1", 2.5, 1, 3000, 400},
		{3 * time.Hour, "sum-b", "key-2", 1, 0, 500, 0},
		{30 * time.Hour, "sum-b", "key-2", 99, 1, 99999, 9999},
	}
	for _, r := range rows {
		value := ""
		if r.key == "key-1" {
			value = "sk-abc****1111"
		}
		if _, err := d.Exec(`INSERT INTO requests (ts, account_id, api_key_id, api_key, credits, success, in_tokens, out_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			now.Add(-r.ago).Unix(), r.account, r.key, value, r.credits, r.success, r.in, r.outT); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDailySummaryContents(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "sum-a", "sum-b", "sum-c")
	if err := config.SetAccountBanStatus("sum-c", "BANNED", "suspended"); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	seedSummaryTraffic(t, now)
	s, err := h.buildDailySummary(now.Add(-24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if s.Totals.Requests != 3 || s.Totals.Failed != 1 || s.Totals.Credits != 5 || s.Totals.InTokens != 4500 || s.Totals.OutTokens != 600 {
		t.Fatalf("totals = %+v", s.Totals)
	}
	if len(s.Accounts) != 2 || s.Accounts[0].Label != "sum-a@example.com" || s.Accounts[0].Requests != 2 {
		t.Fatalf("top accounts = %+v", s.Accounts)
	}
	//! Deleted keys read by the masked value they last sent, so two of them never look alike.
	if len(s.Keys) != 2 || s.Keys[0].Label != "deleted key sk-abc****1111" || s.Keys[1].Label != "deleted key" {
		t.Fatalf("top keys = %+v", s.Keys)
	}
	if len(s.Attention) != 1 || s.Attention[0].ID != "sum-c" || s.Attention[0].Reason != "banned" {
		t.Fatalf("attention = %+v", s.Attention)
	}
	msg := dailySummaryMessage(s, now.Unix())
	for _, want := range []string{"Requests: 3, 1 failed (33.3%)", "Credits used: 5.00", "Tokens: 4,500 in, 600 out",
		"Top accounts: sum-a@example.com, 2 requests (4.00 credits)", "Needs attention:\n- sum-c@example.com: banned or suspended (suspended)", " UTC."} {
		if !strings.Contains(msg.Text, want) {
			t.Fatalf("summary text misses %q:\n%s", want, msg.Text)
		}
	}
	if msg.Severity != "warning" || msg.Event != alertEventDailySummary || len(alertText(msg)) > alertTextLimit+3 {
		t.Fatalf("message = %+v", msg)
	}
}

func TestDailySummaryGoesOutOncePerSlot(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "once-a")
	recv := &summaryReceiver{}
	server := httptest.NewServer(recv.handler(t))
	t.Cleanup(server.Close)
	now := time.Now().UTC()
	slotMinute := (now.Hour()*60 + now.Minute() + 24*60 - 5) % (24 * 60) // five minutes ago
	on := true
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.DailySummary = &on
		c.DailySummaryMinute = &slotMinute
		c.Channels = []config.AlertChannel{{ID: "ch_sum", Type: config.AlertChannelWebhook, Enabled: true, URL: server.URL}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	a := getAlerter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.run(ctx, func() *http.Client { return server.Client() })

	h.runDailySummary(now)
	h.runDailySummary(now.Add(time.Minute))
	deadline := time.Now().Add(5 * time.Second)
	for len(recv.list()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	got := recv.list()
	if len(got) != 1 || got[0].Event != alertEventDailySummary {
		t.Fatalf("received %d alerts (%+v), want one daily summary", len(got), got)
	}
	states, err := loadAlertStates()
	if err != nil {
		t.Fatal(err)
	}
	if st := states[alertKeyDailySummary]; st.Period != dailySummarySlot(now, slotMinute).Format("2006-01-02") || st.SentAt == 0 {
		t.Fatalf("state = %+v", st)
	}
	view := decodeAlerts(t, alertsCall(t, http.MethodGet, "/alerts", ""))
	if !view.DailySummary || view.DailySummaryMinute != slotMinute || view.DailySummaryLastSent == 0 {
		t.Fatalf("view = %+v", view)
	}
}

func TestDailySummaryTestEndpoint(t *testing.T) {
	h := newKeyAccessHandler(t, nil, "tst-a")
	rec := httptest.NewRecorder()
	h.apiTestDailySummary(rec, httptest.NewRequest(http.MethodPost, "/admin/api/alerts/daily-summary/test", nil))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), codeAlertNoChannels) {
		t.Fatalf("no channels: %d %s", rec.Code, rec.Body.String())
	}

	recv := &summaryReceiver{}
	server := httptest.NewServer(recv.handler(t))
	t.Cleanup(server.Close)
	if err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		c.Channels = []config.AlertChannel{{ID: "ch_t", Type: config.AlertChannelWebhook, Enabled: true, URL: server.URL}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.apiTestDailySummary(rec, httptest.NewRequest(http.MethodPost, "/admin/api/alerts/daily-summary/test", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("test send: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Results []dailySummaryTestResult `json:"results"`
		Title   string                   `json:"title"`
		Text    string                   `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Results) != 1 || !resp.Results[0].OK || resp.Results[0].ChannelID != "ch_t" || resp.Title != "Daily usage summary" {
		t.Fatalf("response = %+v", resp)
	}
	if len(recv.list()) != 1 {
		t.Fatalf("receiver got %d alerts", len(recv.list()))
	}
	// A test send is not the day's summary.
	states, _ := loadAlertStates()
	if _, ok := states[alertKeyDailySummary]; ok {
		t.Fatal("a test send marked the day's summary as sent")
	}
}

func TestAlertsAPIDailySummarySettings(t *testing.T) {
	initAlertsTest(t)
	view := decodeAlerts(t, alertsCall(t, http.MethodGet, "/alerts", ""))
	if view.DailySummary || view.DailySummaryMinute != config.DefaultDailySummaryMinute {
		t.Fatalf("defaults = %+v", view)
	}
	view = decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", `{"dailySummary":true,"dailySummaryMinute":0}`))
	if !view.DailySummary || view.DailySummaryMinute != 0 {
		t.Fatalf("after update = %+v", view)
	}
	for _, body := range []string{`{"dailySummaryMinute":-1}`, `{"dailySummaryMinute":1440}`} {
		rec := alertsCall(t, http.MethodPost, "/alerts", body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), codeAlertSummaryTimeRange) {
			t.Fatalf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
}

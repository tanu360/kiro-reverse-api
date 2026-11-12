package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
)

type recordedAlert struct {
	path   string
	header http.Header
	body   []byte
}

// alertReceiver is a local endpoint that records every request and answers
// with the statuses in plan, then 200.
func alertReceiver(t *testing.T, plan ...int) (*httptest.Server, func() []recordedAlert) {
	t.Helper()
	var mu sync.Mutex
	var got []recordedAlert
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		n := len(got)
		got = append(got, recordedAlert{path: r.URL.Path, header: r.Header.Clone(), body: body})
		mu.Unlock()
		if n < len(plan) {
			if plan[n] == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "0.05")
			}
			w.WriteHeader(plan[n])
			_, _ = w.Write([]byte(`{"error":"nope"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []recordedAlert {
		mu.Lock()
		defer mu.Unlock()
		return append([]recordedAlert(nil), got...)
	}
}

func fastAlertRetries(t *testing.T) {
	t.Helper()
	backoff, timeout, retryCap := alertBackoff, alertAttemptTimeout, alertMaxRetryAfter
	alertBackoff = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	alertAttemptTimeout = 2 * time.Second
	alertMaxRetryAfter = 30 * time.Second
	t.Cleanup(func() { alertBackoff, alertAttemptTimeout, alertMaxRetryAfter = backoff, timeout, retryCap })
}

func TestAlertChannelPayloads(t *testing.T) {
	srv, received := alertReceiver(t)
	base := telegramAPIBase
	telegramAPIBase = srv.URL
	t.Cleanup(func() { telegramAPIBase = base })
	msg := bannedMessage(config.Account{ID: "a1", Email: "a<1>@example.test", BanReason: "suspended & gone", BanTime: 1000}, 1000)
	client := srv.Client()
	ctx := context.Background()

	channels := []config.AlertChannel{
		{ID: "w", Type: config.AlertChannelWebhook, URL: srv.URL + "/hook", Secret: "s3cret"},
		{ID: "t", Type: config.AlertChannelTelegram, BotToken: "123456:AbC-dEf", ChatID: "-1001"},
		{ID: "d", Type: config.AlertChannelDiscord, URL: srv.URL + "/api/webhooks/1/tok"},
		{ID: "s", Type: config.AlertChannelSlack, URL: srv.URL + "/services/T/B/X"},
	}
	for _, ch := range channels {
		if r := sendAlert(ctx, client, ch, msg, 0); !r.OK || r.Attempts != 1 || r.Status != 200 {
			t.Fatalf("%s: %+v", ch.Type, r)
		}
	}
	got := received()
	if len(got) != 4 {
		t.Fatalf("received %d requests", len(got))
	}

	hook := got[0]
	var payload alertMessage
	if err := json.Unmarshal(hook.body, &payload); err != nil || payload.Event != alertEventAccountBanned || payload.Title == "" || payload.Data["accountId"] != "a1" {
		t.Fatalf("webhook body = %s (%v)", hook.body, err)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(hook.body)
	if want := "sha256=" + hex.EncodeToString(mac.Sum(nil)); hook.header.Get(alertSignatureHeader) != want {
		t.Fatalf("signature = %q, want %q", hook.header.Get(alertSignatureHeader), want)
	}
	if hook.header.Get("Content-Type") != "application/json" || hook.header.Get("X-Kiro-Proxy-Event") != alertEventAccountBanned {
		t.Fatalf("webhook headers = %v", hook.header)
	}

	tg := got[1]
	var tgBody struct {
		ChatID  string `json:"chat_id"`
		Text    string `json:"text"`
		Preview bool   `json:"disable_web_page_preview"`
	}
	if err := json.Unmarshal(tg.body, &tgBody); err != nil || tg.path != "/bot123456:AbC-dEf/sendMessage" || tgBody.ChatID != "-1001" || !tgBody.Preview {
		t.Fatalf("telegram = %s %s (%v)", tg.path, tg.body, err)
	}
	if !strings.Contains(tgBody.Text, "Account banned") || !strings.Contains(tgBody.Text, "a<1>@example.test") {
		t.Fatalf("telegram text = %q", tgBody.Text)
	}
	if strings.Contains(string(tg.body), "parse_mode") {
		t.Fatal("telegram must send plain text")
	}

	var dc struct {
		Content  string `json:"content"`
		Mentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
	}
	if err := json.Unmarshal(got[2].body, &dc); err != nil || !strings.Contains(dc.Content, "Account banned") || dc.Mentions.Parse == nil || len(dc.Mentions.Parse) != 0 {
		t.Fatalf("discord = %s (%v)", got[2].body, err)
	}

	var sl struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(got[3].body, &sl); err != nil || !strings.Contains(sl.Text, "a&lt;1&gt;@example.test") || !strings.Contains(sl.Text, "suspended &amp; gone") {
		t.Fatalf("slack = %s (%v)", got[3].body, err)
	}
}

func TestAlertTextIsCapped(t *testing.T) {
	text := alertText(alertMessage{Title: "T", Text: strings.Repeat("é", 5000)})
	if n := len([]rune(text)); n != alertTextLimit {
		t.Fatalf("text has %d characters", n)
	}
}

func TestAlertRetryPolicy(t *testing.T) {
	fastAlertRetries(t)
	ctx := context.Background()
	msg := testAlertMessage(1)

	for _, tc := range []struct {
		name     string
		plan     []int
		ok       bool
		attempts int
		status   int
	}{
		{"server error then ok", []int{500}, true, 2, 200},
		{"bad request is final", []int{400}, false, 1, 400},
		{"not found is final", []int{404}, false, 1, 404},
		{"always unavailable", []int{503, 503, 503, 503, 503}, false, 4, 503},
		{"three failures then ok", []int{502, 500, 503}, true, 4, 200},
	} {
		srv, received := alertReceiver(t, tc.plan...)
		ch := config.AlertChannel{ID: "w", Type: config.AlertChannelWebhook, URL: srv.URL + "/hook"}
		r := sendAlert(ctx, srv.Client(), ch, msg, alertRetries)
		if r.OK != tc.ok || r.Attempts != tc.attempts || r.Status != tc.status || len(received()) != tc.attempts {
			t.Fatalf("%s: %+v (received %d)", tc.name, r, len(received()))
		}
		if !tc.ok && !strings.Contains(r.Error, "HTTP ") {
			t.Fatalf("%s: error = %q", tc.name, r.Error)
		}
		if tc.ok && r.Error != "" {
			t.Fatalf("%s: success kept error %q", tc.name, r.Error)
		}
	}

	// 429: the Retry-After (50 ms) is waited out, not the 1 ms backoff.
	srv, _ := alertReceiver(t, http.StatusTooManyRequests)
	start := time.Now()
	r := sendAlert(ctx, srv.Client(), config.AlertChannel{Type: config.AlertChannelDiscord, URL: srv.URL + "/x"}, msg, alertRetries)
	if !r.OK || r.Attempts != 2 || time.Since(start) < 50*time.Millisecond {
		t.Fatalf("429: %+v after %v", r, time.Since(start))
	}

	// No server at all: a network error is retried, and has no status.
	gone := httptest.NewServer(http.NotFoundHandler())
	addr := gone.URL
	gone.Close()
	r = sendAlert(ctx, http.DefaultClient, config.AlertChannel{Type: config.AlertChannelSlack, URL: addr + "/services/x"}, msg, alertRetries)
	if r.OK || r.Attempts != 4 || r.Status != 0 || r.Error == "" {
		t.Fatalf("network: %+v", r)
	}
	// The test button's policy: one attempt.
	r = sendAlert(ctx, http.DefaultClient, config.AlertChannel{Type: config.AlertChannelSlack, URL: addr + "/services/x"}, msg, 0)
	if r.Attempts != 1 {
		t.Fatalf("no retries: %+v", r)
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		in   string
		want time.Duration
	}{
		{"", 0}, {"2", 2 * time.Second}, {"0.5", 500 * time.Millisecond}, {"junk", 0}, {"-1", 0},
		{now.Add(3 * time.Second).Format(http.TimeFormat), 3 * time.Second},
	} {
		if got := parseRetryAfter(tc.in, now); got != tc.want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestAlertAttemptTimeout(t *testing.T) {
	fastAlertRetries(t)
	alertAttemptTimeout = 50 * time.Millisecond
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer srv.Close()
	ch := config.AlertChannel{Type: config.AlertChannelWebhook, URL: srv.URL + "/slow"}
	start := time.Now()
	r := sendAlert(context.Background(), srv.Client(), ch, testAlertMessage(1), 1)
	if r.OK || r.Attempts != 2 || hits.Load() != 2 || !strings.Contains(r.Error, "timed out") {
		t.Fatalf("timeout: %+v (hits %d)", r, hits.Load())
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("two 50 ms attempts took %v", elapsed)
	}

	//! A cancelled send (shutdown) stops without waiting for the remaining retries.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := sendAlert(ctx, srv.Client(), ch, testAlertMessage(1), alertRetries); r.Attempts != 1 {
		t.Fatalf("cancelled: %+v", r)
	}
}

func TestAlertErrorsNeverContainSecrets(t *testing.T) {
	fastAlertRetries(t)
	// A receiver that echoes the request path and body back in its error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad " + r.URL.String() + " " + r.Header.Get(alertSignatureHeader) + " " + string(body)))
	}))
	defer srv.Close()
	base := telegramAPIBase
	telegramAPIBase = srv.URL
	t.Cleanup(func() { telegramAPIBase = base })

	gone := httptest.NewServer(http.NotFoundHandler())
	goneURL := gone.URL
	gone.Close()

	const token = "987654:SECRET-token_value"
	cases := []config.AlertChannel{
		{Type: config.AlertChannelTelegram, BotToken: token, ChatID: "1"},
		{Type: config.AlertChannelDiscord, URL: srv.URL + "/api/webhooks/42/discord-secret-path"},
		{Type: config.AlertChannelSlack, URL: srv.URL + "/services/T000/B000/slack-secret-path?token=q-secret"},
		{Type: config.AlertChannelWebhook, URL: srv.URL + "/hook/webhook-secret-path", Secret: "signing-secret"},
		{Type: config.AlertChannelDiscord, URL: goneURL + "/api/webhooks/42/discord-secret-path"},
	}
	secrets := []string{token, "SECRET-token_value", "discord-secret-path", "slack-secret-path", "q-secret", "webhook-secret-path", "signing-secret"}
	for i, ch := range cases {
		r := sendAlert(context.Background(), http.DefaultClient, ch, testAlertMessage(1), 0)
		if r.OK || r.Error == "" {
			t.Fatalf("case %d: %+v", i, r)
		}
		for _, secret := range secrets {
			if strings.Contains(r.Error, secret) {
				t.Fatalf("case %d leaked %q: %q", i, secret, r.Error)
			}
		}
	}

	// A *url.Error repeats the URL; the scrub unwraps it.
	urlErr := &url.Error{Op: "Post", URL: "https://api.telegram.org/bot" + token + "/sendMessage", Err: errors.New("dial tcp: connection refused")}
	got := scrubAlertError(urlErr, config.AlertChannel{Type: config.AlertChannelTelegram, BotToken: token})
	if strings.Contains(got, token) || strings.Contains(got, "api.telegram.org") || got != "dial tcp: connection refused" {
		t.Fatalf("scrubbed = %q", got)
	}
}

func TestAlertTargetHint(t *testing.T) {
	for _, tc := range []struct {
		ch   config.AlertChannel
		want string
	}{
		{config.AlertChannel{Type: config.AlertChannelDiscord, URL: "https://discord.com/api/webhooks/1/tok"}, "https://discord.com/…"},
		{config.AlertChannel{Type: config.AlertChannelWebhook, URL: "https://user:pw@hooks.example.test:8443/x?y=z"}, "https://hooks.example.test:8443/…"},
		{config.AlertChannel{Type: config.AlertChannelTelegram, BotToken: "123:abc"}, "bot 123"},
		{config.AlertChannel{Type: config.AlertChannelTelegram, BotToken: "nocolon"}, ""},
	} {
		if got := alertTargetHint(tc.ch); got != tc.want {
			t.Errorf("hint(%+v) = %q, want %q", tc.ch, got, tc.want)
		}
	}
}

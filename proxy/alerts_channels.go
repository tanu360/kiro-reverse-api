package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"kiro-proxy/config"
)

// Send policy. Variables so tests can shorten them.
var (
	// telegramAPIBase is the Bot API root; tests point it at a local receiver.
	telegramAPIBase = "https://api.telegram.org"
	// alertAttemptTimeout bounds one HTTP attempt.
	alertAttemptTimeout = 10 * time.Second
	// alertBackoff is the wait before each retry.
	alertBackoff = []time.Duration{1 * time.Second, 2 * time.Second, 4 * time.Second}
	// alertMaxRetryAfter caps how long a 429's Retry-After may hold a retry.
	alertMaxRetryAfter = 30 * time.Second
)

const (
	// alertRetries is how many times a background send retries a network error, 5xx or 429.
	alertRetries = 3
	// alertTextLimit keeps a message under Discord's 2000-character content limit.
	alertTextLimit = 1900
	// alertErrorBodyLimit is how much of a failed response's body is read for
	// the error. The whole read is scrubbed before it is cut to alertErrorTextLimit.
	alertErrorBodyLimit = 4 << 10
	// alertErrorTextLimit is how long a scrubbed error may be in a last result.
	alertErrorTextLimit = 300
	// alertSignatureHeader carries the webhook body's HMAC-SHA256 when a secret is set.
	alertSignatureHeader = "X-Kiro-Proxy-Signature"
)

var (
	alertClientMu    sync.Mutex
	alertClient      *http.Client
	alertClientProxy string
)

// alertHTTPClient is the client alerts go out on. It follows the outbound
// proxy setting (Telegram and Discord are blocked in some regions) and is
// rebuilt when that setting changes. It does not follow redirects: a webhook
// that answers with one is misconfigured, and following it would resend the
// alert to an address nobody entered.
func alertHTTPClient() *http.Client {
	proxyURL := config.GetProxyURL()
	alertClientMu.Lock()
	defer alertClientMu.Unlock()
	if alertClient == nil || alertClientProxy != proxyURL {
		alertClient = &http.Client{
			Transport: buildKiroTransport(proxyURL),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		alertClientProxy = proxyURL
	}
	return alertClient
}

// alertText is the message as one plain-text block for the chat channels.
func alertText(msg alertMessage) string {
	text := "[Kiro Proxy] " + msg.Title
	if msg.Text != "" {
		text += "\n" + msg.Text
	}
	if utf8.RuneCountInString(text) > alertTextLimit {
		runes := []rune(text)
		text = string(runes[:alertTextLimit-1]) + "…"
	}
	return text
}

var slackEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// buildAlertRequest is the HTTP request that delivers msg to ch.
func buildAlertRequest(ctx context.Context, ch config.AlertChannel, msg alertMessage) (*http.Request, error) {
	var target string
	var payload any
	switch ch.Type {
	case config.AlertChannelWebhook:
		target, payload = ch.URL, msg
	case config.AlertChannelTelegram:
		target = strings.TrimRight(telegramAPIBase, "/") + "/bot" + ch.BotToken + "/sendMessage"
		//! No parse_mode: plain text cannot break on an unescaped character in an email or reason.
		payload = map[string]any{"chat_id": ch.ChatID, "text": alertText(msg), "disable_web_page_preview": true}
	case config.AlertChannelDiscord:
		//! allowed_mentions off: an account label like "@everyone" must not ping a server.
		payload = map[string]any{"content": alertText(msg), "allowed_mentions": map[string]any{"parse": []string{}}}
		target = ch.URL
	case config.AlertChannelSlack:
		target, payload = ch.URL, map[string]any{"text": slackEscaper.Replace(alertText(msg))}
	default:
		return nil, fmt.Errorf("unknown channel type %q", ch.Type)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kiro-proxy-alerts/"+config.Version)
	if ch.Type == config.AlertChannelWebhook {
		req.Header.Set("X-Kiro-Proxy-Event", msg.Event)
		if ch.Secret != "" {
			mac := hmac.New(sha256.New, []byte(ch.Secret))
			mac.Write(body)
			req.Header.Set(alertSignatureHeader, "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
	}
	return req, nil
}

// alertAttempt is one try's outcome: the status (0 without a response), the
// Retry-After a 429 asked for, and the error to report.
type alertAttempt struct {
	status     int
	retryAfter time.Duration
	err        error
}

func (a alertAttempt) ok() bool { return a.err == nil && a.status >= 200 && a.status < 300 }

// retryable: no response at all, a server error or a rate limit. Any other 4xx
// is a channel set up wrong, which a retry cannot fix.
func (a alertAttempt) retryable() bool {
	return a.status == 0 || a.status >= 500 || a.status == http.StatusTooManyRequests
}

func doAlertAttempt(ctx context.Context, client *http.Client, ch config.AlertChannel, msg alertMessage) alertAttempt {
	attemptCtx, cancel := context.WithTimeout(ctx, alertAttemptTimeout)
	defer cancel()
	req, err := buildAlertRequest(attemptCtx, ch, msg)
	if err != nil {
		return alertAttempt{err: err}
	}
	resp, err := client.Do(req)
	if err != nil {
		if attemptCtx.Err() != nil && ctx.Err() == nil {
			return alertAttempt{err: fmt.Errorf("timed out after %s", alertAttemptTimeout)}
		}
		return alertAttempt{err: err}
	}
	defer resp.Body.Close()
	head, _ := io.ReadAll(io.LimitReader(resp.Body, alertErrorBodyLimit+1))
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	out := alertAttempt{status: resp.StatusCode}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := alertErrorBody(head, ch)
		if detail != "" {
			out.err = fmt.Errorf("HTTP %d: %s", resp.StatusCode, detail)
		} else {
			out.err = fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			out.retryAfter = parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		}
	}
	return out
}

// alertErrorBody is a failed response's body as error text, still unscrubbed:
// scrubAlertError replaces the secrets in all of it and only then cuts it. A
// body longer than the read limit also loses the tail a secret could be cut
// in, since a cut secret no longer matches and would survive the scrub.
func alertErrorBody(head []byte, ch config.AlertChannel) string {
	if len(head) > alertErrorBodyLimit {
		keep := alertErrorBodyLimit
		for _, secret := range alertSecrets(ch) {
			keep = min(keep, alertErrorBodyLimit-len(secret)+1)
		}
		head = head[:max(keep, 0)]
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(head), ""))
}

// parseRetryAfter reads seconds (Discord sends fractions) or an HTTP date.
func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(value, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}

// sendAlert delivers msg to ch: one attempt, then up to retries more on a
// network error, 5xx or 429, waiting alertBackoff (or a 429's Retry-After, up
// to alertMaxRetryAfter) between them. The error it reports never holds the
// channel's URL, token or secret.
func sendAlert(ctx context.Context, client *http.Client, ch config.AlertChannel, msg alertMessage, retries int) alertDelivery {
	result := alertDelivery{Event: msg.Event}
	for attempt := 1; ; attempt++ {
		a := doAlertAttempt(ctx, client, ch, msg)
		result.Attempts = attempt
		result.Status = a.status
		if a.ok() {
			result.OK = true
			result.Error = ""
			break
		}
		result.Error = scrubAlertError(a.err, ch)
		if !a.retryable() || attempt > retries || ctx.Err() != nil {
			break
		}
		wait := alertBackoff[min(attempt-1, len(alertBackoff)-1)]
		if a.retryAfter > 0 {
			wait = min(a.retryAfter, alertMaxRetryAfter)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		if ctx.Err() != nil {
			break
		}
	}
	result.TS = time.Now().Unix()
	return result
}

// alertSecrets are the strings of ch that must never reach an error, a log
// line or the admin API.
func alertSecrets(ch config.AlertChannel) []string {
	var out []string
	add := func(s string) {
		//! Very short values are skipped: replacing "a" would garble the message without hiding anything.
		if len(s) >= 4 {
			out = append(out, s)
		}
	}
	add(ch.URL)
	add(ch.BotToken)
	add(ch.Secret)
	add(url.PathEscape(ch.BotToken))
	if u, err := url.Parse(ch.URL); err == nil {
		//! Discord and Slack webhook URLs are tokens: their path and query are as secret as the whole URL.
		if len(u.Path) > 1 {
			add(u.Path)
		}
		add(u.RawQuery)
	}
	return out
}

// scrubAlertError is err as text with every secret of ch replaced by ***. A
// *url.Error is unwrapped first: its message repeats the request URL, which
// holds the Telegram token and is itself the Discord or Slack secret.
func scrubAlertError(err error, ch config.AlertChannel) string {
	if err == nil {
		return ""
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		err = urlErr.Err
	}
	text := err.Error()
	for _, secret := range alertSecrets(ch) {
		text = strings.ReplaceAll(text, secret, "***")
	}
	if len(text) > alertErrorTextLimit {
		text = strings.ToValidUTF8(text[:alertErrorTextLimit], "") + "…"
	}
	return text
}

// alertTargetHint names where a channel sends without giving its secret away:
// the scheme and host of a URL, or the bot's numeric id (the part of a
// Telegram token before the colon, which is public).
func alertTargetHint(ch config.AlertChannel) string {
	if ch.Type == config.AlertChannelTelegram {
		if id, _, ok := strings.Cut(ch.BotToken, ":"); ok && id != "" && isDigits(id) {
			return "bot " + id
		}
		return ""
	}
	u, err := url.Parse(ch.URL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host + "/…"
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

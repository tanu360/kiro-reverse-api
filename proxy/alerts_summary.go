package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
)

/*
 * The daily usage summary: once a day, at a time stored in UTC, every enabled
 * channel gets the last 24 hours of traffic (requests, failures, credits,
 * tokens, the busiest accounts and keys) and the accounts that need attention.
 * alert_state remembers the last slot sent, so a restart never sends one twice;
 * a server that was down at the slot catches up within dailySummaryGrace.
 */

const (
	alertEventDailySummary = "daily_summary"
	// alertKeyDailySummary is the alert_state row; its period is the UTC date of the last slot sent.
	alertKeyDailySummary = "daily_summary"
	// dailySummaryGrace is how late a missed slot may still go out (a restart, a sleeping host).
	//! Longer would send yesterday's report at an odd hour; switching the summary on after
	//! today's slot sends nothing until tomorrow's.
	dailySummaryGrace = 3 * time.Hour
	// dailySummaryTop is how many accounts and keys the summary names.
	dailySummaryTop = 3
	// dailySummaryAttention caps the accounts it lists as needing attention.
	dailySummaryAttention = 5
)

// dailySummarySlot is the latest slot at or before now: minute (after
// midnight UTC) on now's UTC day, or on the day before when that is still ahead.
func dailySummarySlot(now time.Time, minute int) time.Time {
	now = now.UTC()
	slot := time.Date(now.Year(), now.Month(), now.Day(), 0, minute, 0, 0, time.UTC)
	if slot.After(now) {
		slot = slot.AddDate(0, 0, -1)
	}
	return slot
}

// dailySummaryDue reports whether the slot before now is still to be sent:
// it has not been (state's period is its UTC date) and it is at most
// dailySummaryGrace old. It also returns that slot.
func dailySummaryDue(now time.Time, minute int, state alertState) (time.Time, bool) {
	slot := dailySummarySlot(now, minute)
	if state.Period == slot.Format("2006-01-02") {
		return slot, false
	}
	return slot, now.Sub(slot) < dailySummaryGrace
}

// untilNextDailySummary is how long until the slot after now.
func untilNextDailySummary(now time.Time, minute int) time.Duration {
	return dailySummarySlot(now, minute).AddDate(0, 0, 1).Sub(now)
}

// summaryTotals is the traffic of one window, or of one account or key in it.
type summaryTotals struct {
	Requests  int64   `json:"requests"`
	Failed    int64   `json:"failed"`
	Credits   float64 `json:"credits"`
	InTokens  int64   `json:"inTokens"`
	OutTokens int64   `json:"outTokens"`
}

// summaryRow is one of the busiest accounts or keys.
type summaryRow struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	summaryTotals
}

// summaryAttention is an account that needs looking at, and why.
type summaryAttention struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Reason string `json:"reason"`
	Text   string `json:"text"`
}

// dailySummary is everything one summary says.
type dailySummary struct {
	From      int64              `json:"from"`
	To        int64              `json:"to"`
	Totals    summaryTotals      `json:"totals"`
	Accounts  []summaryRow       `json:"topAccounts"`
	Keys      []summaryRow       `json:"topKeys"`
	Attention []summaryAttention `json:"attention"`
}

// loadSummaryTraffic reads the request log of [from, to): the totals and the
// busiest accounts and keys, most requests first.
func loadSummaryTraffic(from, to int64) (summaryTotals, []summaryRow, []summaryRow, error) {
	var totals summaryTotals
	d, err := db.Get()
	if err != nil {
		return totals, nil, nil, err
	}
	tx, err := d.Begin()
	if err != nil {
		return totals, nil, nil, err
	}
	defer tx.Rollback()
	const sums = `COUNT(*), COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END), 0), COALESCE(SUM(credits), 0), COALESCE(SUM(in_tokens), 0), COALESCE(SUM(out_tokens), 0)`
	if err := tx.QueryRow(`SELECT `+sums+` FROM requests WHERE ts >= ? AND ts < ?`, from, to).
		Scan(&totals.Requests, &totals.Failed, &totals.Credits, &totals.InTokens, &totals.OutTokens); err != nil {
		return totals, nil, nil, err
	}
	top := func(column string) ([]summaryRow, error) {
		rows, err := tx.Query(`SELECT `+column+`, `+sums+` FROM requests WHERE ts >= ? AND ts < ? AND `+column+` <> ''
GROUP BY `+column+` ORDER BY COUNT(*) DESC, SUM(credits) DESC, `+column+` LIMIT ?`, from, to, dailySummaryTop)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []summaryRow
		for rows.Next() {
			var r summaryRow
			if err := rows.Scan(&r.ID, &r.Requests, &r.Failed, &r.Credits, &r.InTokens, &r.OutTokens); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, rows.Err()
	}
	accounts, err := top("account_id")
	if err != nil {
		return totals, nil, nil, err
	}
	keys, err := top("api_key_id")
	return totals, accounts, keys, err
}

// summaryAttentionFor lists the accounts that need attention: banned or
// suspended (a ban also switches an account off), and, among the enabled ones,
// out of credits or running out before their credits reset. An account the
// admin switched off is left out.
func summaryAttentionFor(accounts []config.Account, forecasts map[string]accountForecast) []summaryAttention {
	var out []summaryAttention
	for _, acc := range accounts {
		banned := acc.BanStatus != "" && acc.BanStatus != "ACTIVE"
		if !acc.Enabled && !banned {
			continue
		}
		label := accountLabel(acc)
		switch f := forecasts[acc.ID]; {
		case banned:
			text := label + ": banned or suspended"
			if acc.BanStatus != "BANNED" {
				text = label + ": switched off by the proxy"
			}
			if reason := strings.TrimSpace(acc.BanReason); reason != "" {
				text += " (" + reason + ")"
			}
			out = append(out, summaryAttention{ID: acc.ID, Label: label, Reason: "banned", Text: text})
		case !acc.Enabled:
		case f.Status == forecastEmpty && !strings.EqualFold(acc.OverageStatus, "ENABLED"):
			text := label + ": out of credits"
			if acc.NextResetDate != "" {
				text += " until " + acc.NextResetDate
			}
			out = append(out, summaryAttention{ID: acc.ID, Label: label, Reason: "out_of_credits", Text: text})
		case f.Status == forecastRunsOut:
			text := fmt.Sprintf("%s: runs out around %s, before its credits reset on %s",
				label, time.Unix(f.DepletesAt, 0).UTC().Format("2006-01-02"), acc.NextResetDate)
			out = append(out, summaryAttention{ID: acc.ID, Label: label, Reason: "runs_out", Text: text})
		}
	}
	return out
}

// buildDailySummary gathers the summary of [from, to).
func (h *Handler) buildDailySummary(from, to time.Time) (dailySummary, error) {
	s := dailySummary{From: from.Unix(), To: to.Unix()}
	totals, accounts, keys, err := loadSummaryTraffic(s.From, s.To)
	if err != nil {
		return s, err
	}
	s.Totals = totals
	stored := config.GetAccounts()
	labels := make(map[string]string, len(stored))
	for _, acc := range stored {
		labels[acc.ID] = accountLabel(acc)
	}
	for _, r := range accounts {
		r.Label = labels[r.ID]
		if r.Label == "" {
			r.Label = "removed account"
		}
		s.Accounts = append(s.Accounts, r)
	}
	keyLabels := make(map[string]string)
	for _, k := range config.ListApiKeys() {
		keyLabels[k.ID] = k.Name
		if k.Name == "" {
			keyLabels[k.ID] = config.MaskApiKey(k.Key)
		}
	}
	for _, r := range keys {
		label, ok := keyLabels[r.ID]
		if !ok {
			label = deletedKeyLabel(r.ID, s.From, s.To)
		}
		r.Label = label
		s.Keys = append(s.Keys, r)
	}
	forecasts, err := h.accountForecasts(stored, to)
	if err != nil {
		//! The traffic is already read; a forecast that failed only leaves out the runs-out hints.
		logger.Warnf("[Alerts] Daily summary forecast failed: %v", err)
	}
	s.Attention = summaryAttentionFor(stored, forecasts)
	return s, nil
}

// deletedKeyLabel names a key config no longer has by the masked value it last
// sent in [from, to), so two deleted keys never read the same. "deleted key"
// alone when the log kept no value.
func deletedKeyLabel(id string, from, to int64) string {
	d, err := db.Get()
	if err != nil {
		return "deleted key"
	}
	var last string
	if err := d.QueryRow(`SELECT api_key FROM requests WHERE api_key_id = ? AND api_key <> '' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`, id, from, to).Scan(&last); err != nil || last == "" {
		return "deleted key"
	}
	return "deleted key " + config.MaskApiKey(last)
}

// groupDigits writes n with thousands separators: 12,345.
func groupDigits(n int64) string {
	raw := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(raw, "-")
	raw = strings.TrimPrefix(raw, "-")
	var b strings.Builder
	for i, r := range raw {
		if i > 0 && (len(raw)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// summaryCredits writes credits with two decimals, as the admin UI shows them.
func summaryCredits(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}

func (t summaryTotals) line() string {
	return fmt.Sprintf("%s (%s credits)", textCount(t.Requests, "request", "requests"), summaryCredits(t.Credits))
}

func textCount(n int64, singular, plural string) string {
	if n == 1 {
		return "1 " + singular
	}
	return groupDigits(n) + " " + plural
}

// dailySummaryMessage is the summary as an alert. The text stays well under
// the chat channels' limit: three names per list and five attention lines.
func dailySummaryMessage(s dailySummary, now int64) alertMessage {
	var b strings.Builder
	from := time.Unix(s.From, 0).UTC().Format("2006-01-02 15:04")
	to := time.Unix(s.To, 0).UTC().Format("2006-01-02 15:04")
	fmt.Fprintf(&b, "Last 24 hours, %s to %s UTC.\n", from, to)
	t := s.Totals
	failed := ""
	if t.Requests > 0 {
		failed = fmt.Sprintf(", %s failed (%.1f%%)", groupDigits(t.Failed), float64(t.Failed)/float64(t.Requests)*100)
	}
	fmt.Fprintf(&b, "Requests: %s%s\n", groupDigits(t.Requests), failed)
	fmt.Fprintf(&b, "Credits used: %s\n", summaryCredits(t.Credits))
	fmt.Fprintf(&b, "Tokens: %s in, %s out\n", groupDigits(t.InTokens), groupDigits(t.OutTokens))
	list := func(title string, rows []summaryRow) {
		if len(rows) == 0 {
			return
		}
		parts := make([]string, len(rows))
		for i, r := range rows {
			parts[i] = r.Label + ", " + r.line()
		}
		fmt.Fprintf(&b, "%s: %s\n", title, strings.Join(parts, "; "))
	}
	list("Top accounts", s.Accounts)
	list("Top keys", s.Keys)
	if len(s.Attention) == 0 {
		b.WriteString("No account needs attention.")
	} else {
		b.WriteString("Needs attention:")
		for i, a := range s.Attention {
			if i == dailySummaryAttention {
				fmt.Fprintf(&b, "\n- and %d more", len(s.Attention)-dailySummaryAttention)
				break
			}
			b.WriteString("\n- " + a.Text)
		}
	}
	severity := "info"
	if len(s.Attention) > 0 {
		severity = "warning"
	}
	return alertMessage{
		Event:    alertEventDailySummary,
		Severity: severity,
		Title:    "Daily usage summary",
		Text:     b.String(),
		Data: map[string]any{
			"from":        s.From,
			"to":          s.To,
			"totals":      s.Totals,
			"topAccounts": nonNilRows(s.Accounts),
			"topKeys":     nonNilRows(s.Keys),
			"attention":   nonNilAttention(s.Attention),
		},
		TS: now,
	}
}

func nonNilRows(rows []summaryRow) []summaryRow {
	if rows == nil {
		return []summaryRow{}
	}
	return rows
}

func nonNilAttention(list []summaryAttention) []summaryAttention {
	if list == nil {
		return []summaryAttention{}
	}
	return list
}

// runDailySummary queues the daily summary when its slot is due. The slot is
// marked sent before the message is queued, as the other rules do, so a
// failing channel never makes it go out twice.
func (h *Handler) runDailySummary(now time.Time) {
	cfg := config.GetAlertsConfig()
	if !cfg.DailySummaryOn() || len(cfg.EnabledChannels()) == 0 {
		return
	}
	a := getAlerter()
	a.evalMu.Lock()
	defer a.evalMu.Unlock()
	states, err := loadAlertStates()
	if err != nil {
		logger.Warnf("[Alerts] Daily summary state could not be read: %v", err)
		return
	}
	slot, due := dailySummaryDue(now, cfg.DailySummaryAt(), states[alertKeyDailySummary])
	if !due {
		return
	}
	summary, err := h.buildDailySummary(slot.Add(-24*time.Hour), slot)
	if err != nil {
		logger.Warnf("[Alerts] Daily summary could not be built: %v", err)
		return
	}
	next := alertState{Period: slot.Format("2006-01-02"), Level: 1, SentAt: now.Unix()}
	if err := saveAlertStates(map[string]alertState{alertKeyDailySummary: next}, nil); err != nil {
		logger.Warnf("[Alerts] Daily summary state could not be saved: %v", err)
		return
	}
	a.enqueue([]alertMessage{dailySummaryMessage(summary, now.Unix())})
}

// dailySummaryTestResult is one channel's result of a test send.
type dailySummaryTestResult struct {
	ChannelID string `json:"channelId"`
	alertDelivery
}

// apiTestDailySummary serves POST /alerts/daily-summary/test: the summary of
// the last 24 hours, sent now to every enabled channel with one attempt each.
// It does not count as the day's summary.
func (h *Handler) apiTestDailySummary(w http.ResponseWriter, r *http.Request) {
	channels := config.GetAlertsConfig().EnabledChannels()
	if len(channels) == 0 {
		writeAdminError(w, http.StatusConflict, codeAlertNoChannels, "Add or switch on an alert channel first")
		return
	}
	now := time.Now()
	summary, err := h.buildDailySummary(now.Add(-24*time.Hour), now)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	msg := dailySummaryMessage(summary, now.Unix())
	results := make([]dailySummaryTestResult, 0, len(channels))
	for _, ch := range channels {
		ctx, cancel := context.WithTimeout(r.Context(), alertAttemptTimeout+time.Second)
		result := getAlerter().deliver(ctx, alertHTTPClient(), ch, msg, 0)
		cancel()
		results = append(results, dailySummaryTestResult{ChannelID: ch.ID, alertDelivery: result})
	}
	publishEvent(eventSettingsChanged, "alerts")
	json.NewEncoder(w).Encode(map[string]any{
		"results": results,
		"title":   msg.Title,
		"text":    msg.Text,
	})
}

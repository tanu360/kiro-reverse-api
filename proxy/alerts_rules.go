package proxy

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"
)

// Alert events, as the webhook payload's "event" and a delivery's last event.
const (
	alertEventAccountUsage   = "account_usage"
	alertEventPoolUsage      = "pool_usage"
	alertEventAccountBanned  = "account_banned"
	alertEventAllUnavailable = "all_unavailable"
	alertEventTest           = "test"
)

// alert_state keys. Account rows carry the account id after the prefix.
const (
	alertKeyAccountPrefix  = "account:"
	alertKeyBannedPrefix   = "banned:"
	alertKeyPool           = "pool"
	alertKeyAllUnavailable = "all_unavailable"
)

const (
	// alertStaleBan is how old a ban may be when first seen and still alert.
	//! Older bans are recorded without a send, so switching alerts on (or adding a first
	//! channel) does not flood the channel with every ban the pool ever had.
	alertStaleBan = time.Hour
	// alertUnavailableGrace is how long no account may serve before that alerts.
	//! Throttle cooldowns empty the pool for seconds at a time; only a lasting outage alerts.
	alertUnavailableGrace = 60 * time.Second
)

// alertState is one alert_state row: the quota period or ban it covers, the
// highest level already notified (a percentage, or 1 for a yes/no rule) and
// when the last message went out.
type alertState struct {
	Period string
	Level  int
	SentAt int64
}

// alertMessage is one alert, as the generic webhook receives it.
type alertMessage struct {
	Event    string         `json:"event"`
	Severity string         `json:"severity"`
	Title    string         `json:"title"`
	Text     string         `json:"text"`
	Data     map[string]any `json:"data,omitempty"`
	TS       int64          `json:"ts"`
}

// highestCrossed is the largest threshold pct has reached, or 0 for none.
func highestCrossed(thresholds []int, pct float64) int {
	crossed := 0
	for _, t := range thresholds {
		//! The epsilon keeps 90.0 computed as 89.99999 from missing the 90 % threshold.
		if pct >= float64(t)-1e-9 && t > crossed {
			crossed = t
		}
	}
	return crossed
}

// usagePercent is the account's base credit use, the quota isOverUsageLimit
// checks. Trial credits do not count.
func usagePercent(acc config.Account) float64 {
	if acc.UsageLimit <= 0 {
		return 0
	}
	return acc.UsageCurrent / acc.UsageLimit * 100
}

// alertUsageEligible reports whether an account counts for the usage rules:
// switched on, not silenced, not banned or disabled, and with a known limit.
func alertUsageEligible(acc config.Account) bool {
	return acc.Enabled && !acc.Silent && (acc.BanStatus == "" || acc.BanStatus == "ACTIVE") && acc.UsageLimit > 0
}

// poolUsage sums used and limit credits over the accounts the usage rules count.
func poolUsage(accounts []config.Account) (used, limit float64, n int) {
	for _, acc := range accounts {
		if !alertUsageEligible(acc) {
			continue
		}
		used += acc.UsageCurrent
		limit += acc.UsageLimit
		n++
	}
	return used, limit, n
}

// evalAccountUsage decides one account's usage alert. send is the threshold to
// notify, 0 for none. A new quota period (NextResetDate) or usage below the
// notified level re-arms the account without a message; several thresholds
// crossed at once notify only the highest.
func evalAccountUsage(acc config.Account, thresholds []int, st alertState, now int64) (send int, next alertState) {
	next = st
	if next.Period != acc.NextResetDate {
		next = alertState{Period: acc.NextResetDate}
	}
	level := highestCrossed(thresholds, usagePercent(acc))
	if level < next.Level {
		next.Level = level
	}
	if level > next.Level {
		next.Level = level
		next.SentAt = now
		send = level
	}
	return send, next
}

// evalPoolUsage decides the pool usage alert. A message waits until cooldown
// has passed since the last one; usage below the notified level re-arms the
// rule but keeps the time of the last message, so a flapping pool still sends
// at most one message per cooldown.
func evalPoolUsage(pct float64, thresholds []int, cooldown time.Duration, st alertState, now int64) (send int, next alertState) {
	next = st
	level := highestCrossed(thresholds, pct)
	if level < next.Level {
		next.Level = level
	}
	if level > next.Level && (st.SentAt == 0 || now-st.SentAt >= int64(cooldown.Seconds())) {
		next.Level = level
		next.SentAt = now
		send = level
	}
	return send, next
}

// evalBanned decides one account's ban alert: once per ban (BanTime). A ban
// older than alertStaleBan when first seen is recorded without a message.
func evalBanned(acc config.Account, st alertState, now int64) (send bool, next alertState) {
	if acc.BanStatus != "BANNED" {
		return false, st
	}
	period := strconv.FormatInt(acc.BanTime, 10)
	if st.Period == period {
		return false, st
	}
	next = alertState{Period: period, Level: 1}
	if acc.BanTime <= 0 || now-acc.BanTime > int64(alertStaleBan.Seconds()) {
		return false, next
	}
	next.SentAt = now
	return true, next
}

// evalAllUnavailable decides the no-account-available alert. since is when the
// outage was first seen (0 = none), kept in memory by the caller. The alert
// fires once the outage has lasted alertUnavailableGrace, once per outage and
// at most once per cooldown; it re-arms when an account is available again.
// wait is how long until the grace runs out, for a re-check (0 = none needed).
func evalAllUnavailable(enabled, available int, since int64, cooldown time.Duration, st alertState, now int64) (send bool, nextSince int64, next alertState, wait time.Duration) {
	next = st
	if enabled == 0 || available > 0 {
		next.Level = 0
		return false, 0, next, 0
	}
	if since == 0 {
		since = now
	}
	grace := int64(alertUnavailableGrace.Seconds())
	if now-since < grace {
		return false, since, next, time.Duration(grace-(now-since)) * time.Second
	}
	if st.Level == 1 {
		return false, since, next, 0
	}
	if st.SentAt > 0 && now-st.SentAt < int64(cooldown.Seconds()) {
		return false, since, next, 0
	}
	next.Level = 1
	next.SentAt = now
	return true, since, next, 0
}

// accountLabel names an account in a message: its email, else its nickname, else its id.
func accountLabel(acc config.Account) string {
	switch {
	case acc.Email != "":
		return acc.Email
	case acc.Nickname != "":
		return acc.Nickname
	default:
		return acc.ID
	}
}

func formatCredits(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func accountUsageMessage(acc config.Account, threshold int, now int64) alertMessage {
	pct := usagePercent(acc)
	severity := "warning"
	if threshold >= 100 {
		severity = "critical"
	}
	label := accountLabel(acc)
	text := fmt.Sprintf("%s has used %.1f%% of its credits (%s of %s).", label, pct, formatCredits(acc.UsageCurrent), formatCredits(acc.UsageLimit))
	if acc.NextResetDate != "" {
		text += " Resets " + acc.NextResetDate + "."
	}
	return alertMessage{
		Event:    alertEventAccountUsage,
		Severity: severity,
		Title:    fmt.Sprintf("Account usage passed %d%%", threshold),
		Text:     text,
		Data: map[string]any{
			"accountId":     acc.ID,
			"account":       label,
			"threshold":     threshold,
			"percent":       roundPercent(pct),
			"used":          acc.UsageCurrent,
			"limit":         acc.UsageLimit,
			"nextResetDate": acc.NextResetDate,
		},
		TS: now,
	}
}

func poolUsageMessage(used, limit float64, n, threshold int, now int64) alertMessage {
	pct := used / limit * 100
	severity := "warning"
	if threshold >= 100 {
		severity = "critical"
	}
	return alertMessage{
		Event:    alertEventPoolUsage,
		Severity: severity,
		Title:    fmt.Sprintf("Pool usage passed %d%%", threshold),
		Text:     fmt.Sprintf("The pool has used %.1f%% of its credits (%s of %s over %d accounts).", pct, formatCredits(used), formatCredits(limit), n),
		Data: map[string]any{
			"threshold": threshold,
			"percent":   roundPercent(pct),
			"used":      used,
			"limit":     limit,
			"accounts":  n,
		},
		TS: now,
	}
}

func bannedMessage(acc config.Account, now int64) alertMessage {
	label := accountLabel(acc)
	reason := strings.TrimSpace(acc.BanReason)
	text := label + " was banned and taken out of the pool."
	if reason != "" {
		text = label + " was banned and taken out of the pool: " + reason
	}
	return alertMessage{
		Event:    alertEventAccountBanned,
		Severity: "critical",
		Title:    "Account banned",
		Text:     text,
		Data: map[string]any{
			"accountId": acc.ID,
			"account":   label,
			"reason":    reason,
			"banTime":   acc.BanTime,
		},
		TS: now,
	}
}

func allUnavailableMessage(enabled int, since, now int64) alertMessage {
	return alertMessage{
		Event:    alertEventAllUnavailable,
		Severity: "critical",
		Title:    "No account available",
		Text:     fmt.Sprintf("None of the %d enabled accounts can serve requests (banned, cooling down or out of credits) since %s.", enabled, time.Unix(since, 0).UTC().Format(time.RFC3339)),
		Data: map[string]any{
			"enabled": enabled,
			"since":   since,
		},
		TS: now,
	}
}

func testAlertMessage(now int64) alertMessage {
	return alertMessage{
		Event:    alertEventTest,
		Severity: "info",
		Title:    "Test alert",
		Text:     "This channel is set up: alerts from Kiro Proxy will arrive here.",
		TS:       now,
	}
}

func roundPercent(pct float64) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(pct, 'f', 1, 64), 64)
	return v
}

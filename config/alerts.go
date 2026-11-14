package config

import (
	"errors"
	"fmt"
	"slices"

	"github.com/google/uuid"
)

// Alert channel types. Each one is a different outbound request shape.
const (
	AlertChannelWebhook  = "webhook"
	AlertChannelTelegram = "telegram"
	AlertChannelDiscord  = "discord"
	AlertChannelSlack    = "slack"
)

const (
	// MaxAlertThresholds is how many percentages one threshold list may hold.
	MaxAlertThresholds = 10
	// MaxAlertChannels is how many channels the alerts config may hold.
	MaxAlertChannels = 20
	// DefaultAlertCooldownMinutes is the pool alert cooldown while none is set.
	DefaultAlertCooldownMinutes = 60
	// MaxAlertCooldownMinutes is the longest pool alert cooldown (one day).
	MaxAlertCooldownMinutes = 1440
	// DefaultDailySummaryMinute is when the daily summary goes out while no
	// time is set: 09:00 UTC, in minutes after midnight UTC.
	DefaultDailySummaryMinute = 9 * 60
	// MaxDailySummaryMinute is the last minute of a UTC day.
	MaxDailySummaryMinute = 24*60 - 1
)

// DefaultAlertThresholds are the usage percentages that alert while no list is set.
var DefaultAlertThresholds = []int{80, 90, 100}

// AlertChannel is one place alerts go to. URL (webhook, Discord, Slack),
// BotToken (Telegram) and Secret (the webhook's signing key) are secrets: the
// admin API never returns them.
type AlertChannel struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name,omitempty"`
	Enabled  bool   `json:"enabled"`
	URL      string `json:"url,omitempty"`
	BotToken string `json:"botToken,omitempty"`
	ChatID   string `json:"chatId,omitempty"`
	Secret   string `json:"secret,omitempty"`
}

// AlertsConfig holds the alert rules and channels. A nil rule toggle is on: no
// alert is sent before a channel exists, so on by default sends nothing by
// itself. The daily summary is the exception: it is a scheduled report, not a
// warning, so it stays off until switched on. Empty threshold lists and a
// zero cooldown mean the defaults.
type AlertsConfig struct {
	AccountUsage        *bool          `json:"accountUsage,omitempty"`
	PoolUsage           *bool          `json:"poolUsage,omitempty"`
	AccountBanned       *bool          `json:"accountBanned,omitempty"`
	AllUnavailable      *bool          `json:"allUnavailable,omitempty"`
	AccountThresholds   []int          `json:"accountThresholds,omitempty"`
	PoolThresholds      []int          `json:"poolThresholds,omitempty"`
	PoolCooldownMinutes int            `json:"poolCooldownMinutes,omitempty"`
	Channels            []AlertChannel `json:"channels,omitempty"`
	// DailySummary sends a usage summary once a day; nil is off.
	DailySummary *bool `json:"dailySummary,omitempty"`
	// DailySummaryMinute is when it goes out, in minutes after midnight UTC
	// (0..1439); nil is DefaultDailySummaryMinute. Stored in UTC, so the local
	// time the admin UI shows moves by an hour when daylight saving starts or ends.
	DailySummaryMinute *int `json:"dailySummaryMinute,omitempty"`
}

func alertToggle(on *bool) bool { return on == nil || *on }

// AccountUsageOn reports whether per-account usage alerts are on.
func (c AlertsConfig) AccountUsageOn() bool { return alertToggle(c.AccountUsage) }

// PoolUsageOn reports whether pool-wide usage alerts are on.
func (c AlertsConfig) PoolUsageOn() bool { return alertToggle(c.PoolUsage) }

// AccountBannedOn reports whether banned-account alerts are on.
func (c AlertsConfig) AccountBannedOn() bool { return alertToggle(c.AccountBanned) }

// AllUnavailableOn reports whether the no-account-available alert is on.
func (c AlertsConfig) AllUnavailableOn() bool { return alertToggle(c.AllUnavailable) }

// DailySummaryOn reports whether the daily summary is on. Off by default.
func (c AlertsConfig) DailySummaryOn() bool { return c.DailySummary != nil && *c.DailySummary }

// DailySummaryAt is when the daily summary goes out, in minutes after
// midnight UTC.
func (c AlertsConfig) DailySummaryAt() int {
	if c.DailySummaryMinute == nil || *c.DailySummaryMinute < 0 || *c.DailySummaryMinute > MaxDailySummaryMinute {
		return DefaultDailySummaryMinute
	}
	return *c.DailySummaryMinute
}

// EnabledChannels is the channels that are switched on, in config order.
func (c AlertsConfig) EnabledChannels() []AlertChannel {
	var out []AlertChannel
	for _, ch := range c.Channels {
		if ch.Enabled {
			out = append(out, ch)
		}
	}
	return out
}

// Channel returns the channel with id.
func (c AlertsConfig) Channel(id string) (AlertChannel, bool) {
	for _, ch := range c.Channels {
		if ch.ID == id {
			return ch, true
		}
	}
	return AlertChannel{}, false
}

func cloneAlertsConfig(c AlertsConfig) AlertsConfig {
	out := c
	copyBool := func(p *bool) *bool {
		if p == nil {
			return nil
		}
		v := *p
		return &v
	}
	out.AccountUsage = copyBool(c.AccountUsage)
	out.PoolUsage = copyBool(c.PoolUsage)
	out.AccountBanned = copyBool(c.AccountBanned)
	out.AllUnavailable = copyBool(c.AllUnavailable)
	out.DailySummary = copyBool(c.DailySummary)
	if c.DailySummaryMinute != nil {
		v := *c.DailySummaryMinute
		out.DailySummaryMinute = &v
	}
	out.AccountThresholds = slices.Clone(c.AccountThresholds)
	out.PoolThresholds = slices.Clone(c.PoolThresholds)
	out.Channels = slices.Clone(c.Channels)
	return out
}

// GetAlertsConfig returns a copy of the alerts config with the default
// thresholds and cooldown filled in. The rule toggles stay as stored; read them
// through the *On methods.
func GetAlertsConfig() AlertsConfig {
	cfgLock.RLock()
	var out AlertsConfig
	if cfg != nil {
		out = cloneAlertsConfig(cfg.Alerts)
	}
	cfgLock.RUnlock()
	if len(out.AccountThresholds) == 0 {
		out.AccountThresholds = slices.Clone(DefaultAlertThresholds)
	}
	if len(out.PoolThresholds) == 0 {
		out.PoolThresholds = slices.Clone(DefaultAlertThresholds)
	}
	if out.PoolCooldownMinutes <= 0 {
		out.PoolCooldownMinutes = DefaultAlertCooldownMinutes
	}
	return out
}

// UpdateAlertsConfig applies fn to a copy of the stored alerts config and saves
// the result. Nothing is stored when fn returns an error.
func UpdateAlertsConfig(fn func(*AlertsConfig) error) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not loaded")
	}
	next := cloneAlertsConfig(cfg.Alerts)
	if err := fn(&next); err != nil {
		return err
	}
	cfg.Alerts = next
	return Save()
}

// ValidateAlertThresholds checks a threshold list: 1 to MaxAlertThresholds
// whole percentages from 1 to 100, strictly ascending.
func ValidateAlertThresholds(thresholds []int) error {
	if len(thresholds) == 0 || len(thresholds) > MaxAlertThresholds {
		return fmt.Errorf("thresholds must hold 1 to %d values", MaxAlertThresholds)
	}
	for i, v := range thresholds {
		if v < 1 || v > 100 {
			return fmt.Errorf("threshold %d is outside 1..100", v)
		}
		if i > 0 && v <= thresholds[i-1] {
			return errors.New("thresholds must be strictly ascending")
		}
	}
	return nil
}

// NewAlertChannelID returns a fresh channel id.
func NewAlertChannelID() string {
	return "ch_" + uuid.NewString()
}

// MergeAlertChannels is the channel list after an admin edit. incoming replaces
// the stored list: an entry whose id names a stored channel of the same type
// keeps each stored secret it leaves blank, so a form never has to send a
// secret back. An entry with a new or unknown id gets a fresh id. A channel
// whose type changed keeps none of its old secrets.
func MergeAlertChannels(stored, incoming []AlertChannel) []AlertChannel {
	byID := make(map[string]AlertChannel, len(stored))
	for _, ch := range stored {
		byID[ch.ID] = ch
	}
	out := make([]AlertChannel, 0, len(incoming))
	seen := make(map[string]bool, len(incoming))
	for _, ch := range incoming {
		prev, known := byID[ch.ID]
		if !known || seen[ch.ID] {
			ch.ID = NewAlertChannelID()
		} else if prev.Type == ch.Type {
			if ch.URL == "" {
				ch.URL = prev.URL
			}
			if ch.BotToken == "" {
				ch.BotToken = prev.BotToken
			}
			if ch.Secret == "" {
				ch.Secret = prev.Secret
			}
		}
		seen[ch.ID] = true
		out = append(out, ch)
	}
	return out
}

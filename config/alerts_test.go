package config

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestAlertsConfigDefaults(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	got := GetAlertsConfig()
	if !got.AccountUsageOn() || !got.PoolUsageOn() || !got.AccountBannedOn() || !got.AllUnavailableOn() {
		t.Fatalf("rule toggles should default to on: %+v", got)
	}
	if !slices.Equal(got.AccountThresholds, []int{80, 90, 100}) || !slices.Equal(got.PoolThresholds, []int{80, 90, 100}) {
		t.Fatalf("thresholds = %v / %v", got.AccountThresholds, got.PoolThresholds)
	}
	if got.PoolCooldownMinutes != DefaultAlertCooldownMinutes {
		t.Fatalf("cooldown = %d", got.PoolCooldownMinutes)
	}
	//! The returned lists are copies: changing them must not reach the defaults or the stored config.
	got.AccountThresholds[0] = 1
	if DefaultAlertThresholds[0] != 80 || GetAlertsConfig().AccountThresholds[0] != 80 {
		t.Fatal("GetAlertsConfig returned a shared slice")
	}

	off := false
	if err := UpdateAlertsConfig(func(c *AlertsConfig) error {
		c.PoolUsage = &off
		c.PoolThresholds = []int{50}
		c.PoolCooldownMinutes = 5
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	//! Survives a reload from the database.
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	got = GetAlertsConfig()
	if got.PoolUsageOn() || !got.AccountUsageOn() || !slices.Equal(got.PoolThresholds, []int{50}) || got.PoolCooldownMinutes != 5 {
		t.Fatalf("after save = %+v", got)
	}
}

func TestValidateAlertThresholds(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []int
		ok   bool
	}{
		{"empty", nil, false},
		{"eleven", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, false},
		{"zero", []int{0, 50}, false},
		{"over 100", []int{50, 101}, false},
		{"unsorted", []int{90, 80}, false},
		{"duplicate", []int{80, 80}, false},
		{"valid", []int{1, 50, 100}, true},
		{"ten", []int{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}, true},
	} {
		if err := ValidateAlertThresholds(tc.in); (err == nil) != tc.ok {
			t.Errorf("%s: err = %v", tc.name, err)
		}
	}
}

func TestUpdateAlertsConfigKeepsBlankSecrets(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	stored := []AlertChannel{
		{ID: "ch_hook", Type: AlertChannelWebhook, Name: "hook", Enabled: true, URL: "https://example.test/hook/abc", Secret: "sign-me"},
		{ID: "ch_tg", Type: AlertChannelTelegram, Name: "tg", Enabled: true, BotToken: "123:secret", ChatID: "42"},
	}
	if err := UpdateAlertsConfig(func(c *AlertsConfig) error { c.Channels = stored; return nil }); err != nil {
		t.Fatal(err)
	}

	incoming := []AlertChannel{
		// Renamed, secrets left blank: both kept.
		{ID: "ch_hook", Type: AlertChannelWebhook, Name: "renamed", Enabled: false},
		// Type changed: the old token must not follow it.
		{ID: "ch_tg", Type: AlertChannelSlack, Name: "now slack", Enabled: true, URL: "https://hooks.slack.test/x"},
		// No id: created with a fresh one.
		{Type: AlertChannelDiscord, Name: "new", Enabled: true, URL: "https://discord.test/api/webhooks/1/t"},
	}
	if err := UpdateAlertsConfig(func(c *AlertsConfig) error {
		c.Channels = MergeAlertChannels(c.Channels, incoming)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got := GetAlertsConfig().Channels
	if len(got) != 3 {
		t.Fatalf("channels = %+v", got)
	}
	if got[0].ID != "ch_hook" || got[0].Name != "renamed" || got[0].Enabled || got[0].URL != "https://example.test/hook/abc" || got[0].Secret != "sign-me" {
		t.Fatalf("webhook = %+v", got[0])
	}
	if got[1].ID != "ch_tg" || got[1].Type != AlertChannelSlack || got[1].BotToken != "" || got[1].URL != "https://hooks.slack.test/x" {
		t.Fatalf("retyped = %+v", got[1])
	}
	if !strings.HasPrefix(got[2].ID, "ch_") || got[2].ID == "ch_" || got[2].URL == "" {
		t.Fatalf("created = %+v", got[2])
	}

	//! A failing update stores nothing.
	if err := UpdateAlertsConfig(func(c *AlertsConfig) error {
		c.Channels = nil
		return ErrApiKeyEmpty
	}); err == nil {
		t.Fatal("expected the error back")
	}
	if n := len(GetAlertsConfig().Channels); n != 3 {
		t.Fatalf("failed update changed the channels: %d", n)
	}
}

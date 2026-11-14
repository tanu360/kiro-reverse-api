package config

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestApiKeyControlsAreStoredAndSurviveLoad(t *testing.T) {
	initAccessTest(t, "acc-a")
	created, err := AddApiKey(ApiKeyEntry{
		Key:           "sk-controls",
		Enabled:       true,
		AccountTags:   []string{" team-a ", "TEAM-A", "eu,west"},
		AllowedModels: []string{" claude-haiku-4.5", "Claude-Haiku-4.5", "", "auto"},
		RPMLimit:      30,
		ExpiresAt:     1_900_000_000,
		RoutingMode:   "inherit",
	})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if want := []string{"team-a", "eu west"}; !reflect.DeepEqual(created.AccountTags, want) {
		t.Fatalf("tags = %q, want %q", created.AccountTags, want)
	}
	if want := []string{"claude-haiku-4.5", "auto"}; !reflect.DeepEqual(created.AllowedModels, want) {
		t.Fatalf("models = %q, want %q", created.AllowedModels, want)
	}
	if created.RoutingMode != "" {
		t.Fatalf("inherit stored as %q, want \"\"", created.RoutingMode)
	}

	patch := *GetApiKeyEntry(created.ID)
	patch.Key = ""
	patch.RoutingMode = RoutingModeResetFirst
	patch.RPMLimit = 0
	patch.AllowedModels = nil
	if err := UpdateApiKey(created.ID, patch); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := GetApiKeyEntry(created.ID)
	if got.RoutingMode != RoutingModeResetFirst || got.RPMLimit != 0 || got.AllowedModels != nil || got.ExpiresAt != 1_900_000_000 {
		t.Fatalf("after reload: mode=%q rpm=%d models=%q expires=%d", got.RoutingMode, got.RPMLimit, got.AllowedModels, got.ExpiresAt)
	}
	if !reflect.DeepEqual(got.AccountTags, []string{"team-a", "eu west"}) {
		t.Fatalf("tags after reload = %q", got.AccountTags)
	}
}

func TestApiKeyControlsRejectBadValues(t *testing.T) {
	initAccessTest(t)
	manyModels := make([]string, MaxApiKeyModels+1)
	for i := range manyModels {
		manyModels[i] = "model-" + strings.Repeat("x", i%5) + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	manyTags := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}
	for _, tc := range []struct {
		name  string
		entry ApiKeyEntry
		want  error
	}{
		{"rpm negative", ApiKeyEntry{RPMLimit: -1}, ErrApiKeyRPMLimitRange},
		{"rpm too high", ApiKeyEntry{RPMLimit: MaxApiKeyRPMLimit + 1}, ErrApiKeyRPMLimitRange},
		{"expiry negative", ApiKeyEntry{ExpiresAt: -5}, ErrApiKeyExpiryNegative},
		{"routing mode", ApiKeyEntry{RoutingMode: "fastest"}, ErrApiKeyRoutingMode},
		{"too many models", ApiKeyEntry{AllowedModels: manyModels}, ErrApiKeyTooManyModels},
		{"model too long", ApiKeyEntry{AllowedModels: []string{strings.Repeat("m", MaxApiKeyModelRunes+1)}}, ErrApiKeyModelTooLong},
		{"too many tags", ApiKeyEntry{AccountTags: manyTags}, ErrApiKeyTooManyTags},
	} {
		tc.entry.Key = "sk-bad-" + strings.ReplaceAll(tc.name, " ", "-")
		tc.entry.Enabled = true
		if _, err := AddApiKey(tc.entry); !errors.Is(err, tc.want) {
			t.Fatalf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
	if keys := ListApiKeys(); len(keys) != 0 {
		t.Fatalf("a rejected key was stored: %d keys", len(keys))
	}
	// Exactly at the bounds is fine.
	if _, err := AddApiKey(ApiKeyEntry{Key: "sk-edge", Enabled: true, RPMLimit: MaxApiKeyRPMLimit, AccountTags: manyTags[:MaxAccountTags]}); err != nil {
		t.Fatalf("bounds: %v", err)
	}
}

func TestApiKeyAllowedAccountsUnionsIDsAndTags(t *testing.T) {
	accounts := []Account{
		{ID: "a", Tags: []string{"Team-A"}},
		{ID: "b", Tags: []string{"other"}},
		{ID: "c", Tags: []string{"eu", "team-a"}},
		{ID: "d"},
	}
	if got := ApiKeyAllowedAccounts(ApiKeyEntry{}, accounts); got != nil {
		t.Fatalf("unscoped key = %v, want nil (every account)", got)
	}
	got := ApiKeyAllowedAccounts(ApiKeyEntry{AccountIDs: []string{"d"}, AccountTags: []string{"team-a"}}, accounts)
	if want := map[string]bool{"a": true, "c": true, "d": true}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids + tags = %v, want %v", got, want)
	}
	none := ApiKeyAllowedAccounts(ApiKeyEntry{AccountTags: []string{"nobody"}}, accounts)
	if none == nil || len(none) != 0 {
		t.Fatalf("tag without accounts = %v, want an empty, non-nil set", none)
	}
}

func TestApiKeyAllowsModelAndExpiry(t *testing.T) {
	open := ApiKeyEntry{}
	if !ApiKeyAllowsModel(open, "anything") {
		t.Fatal("a key without a model list refused a model")
	}
	limited := ApiKeyEntry{AllowedModels: []string{"claude-haiku-4.5"}}
	if !ApiKeyAllowsModel(limited, "Claude-Haiku-4.5") || ApiKeyAllowsModel(limited, "claude-sonnet-4.5") {
		t.Fatal("model list match is wrong")
	}
	now := time.Unix(2_000_000_000, 0)
	if ApiKeyExpired(ApiKeyEntry{}, now) || ApiKeyExpired(ApiKeyEntry{ExpiresAt: now.Unix() + 1}, now) {
		t.Fatal("a key without expiry, or not yet expired, reads as expired")
	}
	if !ApiKeyExpired(ApiKeyEntry{ExpiresAt: now.Unix()}, now) {
		t.Fatal("a key at its expiry second still works")
	}
}

func TestResetFirstRoutingModeIsValid(t *testing.T) {
	initAccessTest(t)
	if err := UpdateRoutingMode(RoutingModeResetFirst); err != nil {
		t.Fatalf("set reset_first: %v", err)
	}
	if got := GetRoutingMode(); got != RoutingModeResetFirst {
		t.Fatalf("routing mode = %q, want reset_first", got)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := GetRoutingMode(); got != RoutingModeResetFirst {
		t.Fatalf("after reload = %q, want reset_first", got)
	}
}

func TestDailySummaryConfigDefaults(t *testing.T) {
	var c AlertsConfig
	if c.DailySummaryOn() {
		t.Fatal("daily summary is on by default")
	}
	if c.DailySummaryAt() != DefaultDailySummaryMinute {
		t.Fatalf("default time = %d", c.DailySummaryAt())
	}
	on, minute := true, 0
	c.DailySummary, c.DailySummaryMinute = &on, &minute
	if !c.DailySummaryOn() || c.DailySummaryAt() != 0 {
		t.Fatalf("on at midnight UTC reads as on=%v at=%d", c.DailySummaryOn(), c.DailySummaryAt())
	}
	clone := cloneAlertsConfig(c)
	*clone.DailySummaryMinute = 600
	if *c.DailySummaryMinute != 0 {
		t.Fatal("the clone shares the minute with the stored config")
	}
}

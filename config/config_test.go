package config

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestUpdateSettingsPatchPreservesOmittedAPIKeyFields(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateSettings("proxy-api-key", true, "admin-password"); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	if err := UpdateSettingsPatch(nil, nil, "new-admin-password"); err != nil {
		t.Fatalf("patch settings: %v", err)
	}

	if got := GetApiKey(); got != "proxy-api-key" {
		t.Fatalf("expected API key to be preserved, got %q", got)
	}
	if !IsApiKeyRequired() {
		t.Fatalf("expected requireApiKey to stay enabled")
	}
	if got := GetPassword(); got != "new-admin-password" {
		t.Fatalf("expected password to update, got %q", got)
	}
}

func TestUpdateSettingsPatchCanExplicitlyDisableAPIKey(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateSettings("proxy-api-key", true, "admin-password"); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	emptyKey := ""
	requireAPIKey := false
	if err := UpdateSettingsPatch(&emptyKey, &requireAPIKey, ""); err != nil {
		t.Fatalf("patch settings: %v", err)
	}

	if got := GetApiKey(); got != "" {
		t.Fatalf("expected API key to be cleared, got %q", got)
	}
	if IsApiKeyRequired() {
		t.Fatalf("expected requireApiKey to be disabled")
	}
	if got := GetPassword(); got != "admin-password" {
		t.Fatalf("expected password to be preserved, got %q", got)
	}
}

func TestBackupRestoreIncludesCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	if err := Init(filepath.Join(dir, "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	original := []Account{{
		ID:           "cred-1",
		Email:        "one@example.com",
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		AuthMethod:   "social",
		Region:       "us-east-1",
		Enabled:      true,
	}}
	if err := ReplaceCredentials(true, original); err != nil {
		t.Fatalf("seed credentials: %v", err)
	}

	entry, err := CreateBackup("manual", "credentials snapshot")
	if err != nil {
		t.Fatalf("create backup: %v", err)
	}
	if !entry.IncludesCredentials {
		t.Fatalf("expected backup entry to include credentials")
	}

	if err := ReplaceCredentials(true, []Account{{
		ID:           "cred-2",
		Email:        "two@example.com",
		AccessToken:  "access-2",
		RefreshToken: "refresh-2",
		AuthMethod:   "social",
		Region:       "us-east-1",
		Enabled:      true,
	}}); err != nil {
		t.Fatalf("mutate credentials: %v", err)
	}

	if err := RestoreBackup(entry.ID); err != nil {
		t.Fatalf("restore backup: %v", err)
	}
	loaded, restored := CredentialsSnapshot()
	if !loaded {
		t.Fatalf("expected credentials mode after restore")
	}
	if len(restored) != 1 || restored[0].ID != "cred-1" || restored[0].RefreshToken != "refresh-1" {
		t.Fatalf("unexpected restored credentials: %#v", restored)
	}
}

func TestRestoreRejectsEmptyJSON(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := RestoreFromBytes([]byte(`{}`), "bad"); err == nil {
		t.Fatalf("expected empty JSON restore to be rejected")
	}
}

func TestRestoreRejectsLegacyConfigOnlyBackupWhenCredentialsLoaded(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := ReplaceCredentials(true, []Account{{
		ID:           "cred-1",
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		AuthMethod:   "social",
		Region:       "us-east-1",
		Enabled:      true,
	}}); err != nil {
		t.Fatalf("seed credentials: %v", err)
	}
	legacy, err := json.Marshal(Config{
		Password:      "changeme",
		Port:          8080,
		Host:          "0.0.0.0",
		RequireApiKey: false,
		Accounts:      []Account{},
	})
	if err != nil {
		t.Fatalf("marshal legacy config: %v", err)
	}
	if err := RestoreFromBytes(legacy, "legacy"); err == nil {
		t.Fatalf("expected legacy config-only restore to be rejected while credentials are loaded")
	}
}

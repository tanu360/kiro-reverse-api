package config

import (
	"path/filepath"
	"testing"
)

func TestUpdateSettingsPatchPreservesOmittedAuthFields(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	requireAPIKey := true
	if err := UpdateSettingsPatch(&requireAPIKey, "admin-password"); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	if err := UpdateSettingsPatch(nil, "new-admin-password"); err != nil {
		t.Fatalf("patch settings: %v", err)
	}

	if !IsApiKeyRequired() {
		t.Fatalf("expected requireApiKey to stay enabled")
	}
	if got := GetPassword(); got != "new-admin-password" {
		t.Fatalf("expected password to update, got %q", got)
	}
}

func TestUpdateSettingsPatchCanExplicitlyDisableAPIKeyRequirement(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	requireAPIKey := true
	if err := UpdateSettingsPatch(&requireAPIKey, "admin-password"); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	requireAPIKey = false
	if err := UpdateSettingsPatch(&requireAPIKey, ""); err != nil {
		t.Fatalf("patch settings: %v", err)
	}

	if IsApiKeyRequired() {
		t.Fatalf("expected requireApiKey to be disabled")
	}
	if got := GetPassword(); got != "admin-password" {
		t.Fatalf("expected password to be preserved, got %q", got)
	}
}

func TestUpdateBackupSchedulePreservesLastRun(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateBackupSchedule(BackupSchedule{
		Enabled: true,
		Cadence: "daily",
		Keep:    7,
	}); err != nil {
		t.Fatalf("seed schedule: %v", err)
	}
	const lastRun int64 = 1779654646
	if err := MarkScheduleRan(lastRun); err != nil {
		t.Fatalf("mark schedule ran: %v", err)
	}

	if err := UpdateBackupSchedule(BackupSchedule{
		Enabled: true,
		Cadence: "daily",
		Keep:    7,
	}); err != nil {
		t.Fatalf("update schedule: %v", err)
	}

	got := GetBackupSchedule()
	if got.LastRun != lastRun {
		t.Fatalf("expected lastRun to be preserved, got %d", got.LastRun)
	}
	if !got.Enabled || got.Cadence != "daily" || got.Keep != 7 {
		t.Fatalf("unexpected schedule after update: %#v", got)
	}
}

func TestBackupRestoreIncludesCredentialsData(t *testing.T) {
	dir := t.TempDir()
	if err := Init(filepath.Join(dir, "kiro.db")); err != nil {
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

func TestCreateBackupAllowsSamePayloadInSameSecond(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	first, err := CreateBackup("manual", "first")
	if err != nil {
		t.Fatalf("create first backup: %v", err)
	}
	second, err := CreateBackup("manual", "second")
	if err != nil {
		t.Fatalf("create second backup: %v", err)
	}
	if first.ID == second.ID {
		t.Fatalf("expected unique backup IDs, got %q", first.ID)
	}
	backups, err := ListBackups(true)
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	if len(backups) != 2 {
		t.Fatalf("expected 2 backups, got %d", len(backups))
	}
}

func TestRestoreRejectsEmptyJSON(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := RestoreFromBytes([]byte(`{}`), "bad"); err == nil {
		t.Fatalf("expected empty JSON restore to be rejected")
	}
}

func TestRestoreRejectsConfigOnlyBackup(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	rawConfig := []byte(`{"password":"changeme","port":8080,"host":"0.0.0.0","requireApiKey":false,"accounts":[]}`)
	if err := RestoreFromBytes(rawConfig, "raw-config"); err == nil {
		t.Fatalf("expected config-only restore to be rejected")
	}
}

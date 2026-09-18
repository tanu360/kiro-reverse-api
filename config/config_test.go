package config

import (
	"errors"
	"path/filepath"
	"strings"
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

func TestModelMappingsDefaultAndUpdate(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	defaults := GetModelMappings()
	if len(defaults) == 0 {
		t.Fatalf("expected default model mappings")
	}
	defaults[0].Key = "mutated"
	if got := GetModelMappings()[0].Key; got == "mutated" {
		t.Fatalf("expected model mappings to be returned as a copy")
	}

	custom := []ModelMappingRule{
		{Key: "  My-Alias  ", Value: " claude-haiku-4.5 "},
		{Key: "", Value: "claude-opus-4.8"},
		{Key: "blank-target", Value: ""},
	}
	if err := UpdateModelMappings(custom); err != nil {
		t.Fatalf("update mappings: %v", err)
	}
	got := GetModelMappings()
	if len(got) != 1 || got[0].Key != "my-alias" || got[0].Value != "claude-haiku-4.5" {
		t.Fatalf("unexpected cleaned mappings: %#v", got)
	}

	if err := UpdateModelMappings([]ModelMappingRule{}); err != nil {
		t.Fatalf("clear mappings: %v", err)
	}
	if got := GetModelMappings(); len(got) != 0 {
		t.Fatalf("expected explicit empty mappings to be preserved, got %#v", got)
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

func TestNormalizeAPIKeyAccountPipeRegionAndMachineId(t *testing.T) {
	account := Account{
		KiroApiKey:   " ksk_test_key|EU-Central-1 ",
		AuthMethod:   "API KEY",
		RefreshToken: "stale-refresh",
		ClientID:     "stale-client",
		ClientSecret: "stale-secret",
		ProfileArn:   "arn:aws:codewhisperer:us-east-1:123456789012:profile/STALE",
		ExpiresAt:    1234,
	}
	if err := NormalizeAPIKeyAccount(&account); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if account.KiroApiKey != "ksk_test_key" {
		t.Fatalf("key = %q", account.KiroApiKey)
	}
	if account.AccessToken != "ksk_test_key" {
		t.Fatalf("accessToken should mirror api key, got %q", account.AccessToken)
	}
	if account.AuthMethod != AuthMethodAPIKey {
		t.Fatalf("authMethod = %q", account.AuthMethod)
	}
	if account.Region != "eu-central-1" {
		t.Fatalf("region = %q", account.Region)
	}
	if account.RefreshToken != "" || account.ClientID != "" || account.ClientSecret != "" ||
		account.ProfileArn != "" || account.ExpiresAt != 0 {
		t.Fatalf("oauth fields should be cleared: %+v", account)
	}
	if want := MachineIdFromAPIKey("ksk_test_key"); account.MachineId != want {
		t.Fatalf("machineId = %q, want %q", account.MachineId, want)
	}
	if account.Email == "" || strings.Contains(account.Email, "ksk_") {
		t.Fatalf("label must be set and must not leak the key, got %q", account.Email)
	}
	if !IsAPIKeyAccount(&account) {
		t.Fatal("expected IsAPIKeyAccount true")
	}
}

func TestNormalizeAPIKeyAccountRegionPrecedence(t *testing.T) {
	explicit := Account{KiroApiKey: "ksk_a|eu-central-1", Region: "us-west-2"}
	if err := NormalizeAPIKeyAccount(&explicit); err != nil {
		t.Fatalf("normalize explicit: %v", err)
	}
	if explicit.Region != "us-west-2" {
		t.Fatalf("explicit Region should win over the key suffix, got %q", explicit.Region)
	}

	fallback := Account{AccessToken: "ksk_b", AuthMethod: "apikey"}
	if err := NormalizeAPIKeyAccount(&fallback); err != nil {
		t.Fatalf("normalize fallback: %v", err)
	}
	if fallback.KiroApiKey != "ksk_b" || fallback.Region != "us-east-1" {
		t.Fatalf("expected key from accessToken and default region, got key=%q region=%q", fallback.KiroApiKey, fallback.Region)
	}

	bad := Account{KiroApiKey: "ksk_c", Region: "evil.example.com/x"}
	if err := NormalizeAPIKeyAccount(&bad); !errors.Is(err, ErrInvalidKiroRegion) {
		t.Fatalf("expected ErrInvalidKiroRegion for a host-like region, got %v", err)
	}
}

func TestSplitKiroAPIKeyAndRegionValidation(t *testing.T) {
	key, region, err := SplitKiroAPIKeyAndRegion("ksk_abc|us-east-1")
	if err != nil || key != "ksk_abc" || region != "us-east-1" {
		t.Fatalf("got key=%q region=%q err=%v", key, region, err)
	}
	if _, _, err := SplitKiroAPIKeyAndRegion("ksk_abc|us-east-1|extra"); err == nil {
		t.Fatal("expected multi-pipe error")
	}
	if _, _, err := SplitKiroAPIKeyAndRegion("|us-east-1"); !errors.Is(err, ErrEmptyKiroAPIKey) {
		t.Fatalf("expected ErrEmptyKiroAPIKey, got %v", err)
	}
	if _, _, err := SplitKiroAPIKeyAndRegion("ksk_abc\r\nX-Injected: 1"); !errors.Is(err, ErrInvalidKiroAPIKey) {
		t.Fatalf("expected ErrInvalidKiroAPIKey for header-breaking bytes, got %v", err)
	}
	if _, _, err := SplitKiroAPIKeyAndRegion("ksk_abc|attacker.example"); !errors.Is(err, ErrInvalidKiroRegion) {
		t.Fatalf("expected ErrInvalidKiroRegion, got %v", err)
	}
}

func TestLooksLikeKiroAPIKey(t *testing.T) {
	for _, v := range []string{"ksk_abc", " ksk_abc|eu-central-1 "} {
		if !LooksLikeKiroAPIKey(v) {
			t.Fatalf("expected %q to look like an API key", v)
		}
	}
	for _, v := range []string{"", "aoaAAAA", "Bearer ksk_abc"} {
		if LooksLikeKiroAPIKey(v) {
			t.Fatalf("expected %q not to look like an API key", v)
		}
	}
}

func TestAddAccountRejectsDuplicateAPIKey(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	first := Account{ID: "api-1", KiroApiKey: "ksk_dup", AuthMethod: AuthMethodAPIKey, Enabled: true}
	if err := AddAccount(first); err != nil {
		t.Fatalf("add first: %v", err)
	}
	//! The pipe form normalizes to the same key, so it must count as a duplicate too.
	second := Account{ID: "api-2", KiroApiKey: "ksk_dup|eu-central-1", AuthMethod: AuthMethodAPIKey, Enabled: true}
	if err := AddAccount(second); !errors.Is(err, ErrDuplicateKiroAPIKey) {
		t.Fatalf("expected ErrDuplicateKiroAPIKey, got %v", err)
	}
	if !AccountAPIKeyExists(" ksk_dup ") {
		t.Fatal("expected AccountAPIKeyExists to find the stored key")
	}
	if n := len(GetAccounts()); n != 1 {
		t.Fatalf("expected 1 account after duplicate rejection, got %d", n)
	}
}

func TestAddCredentialRejectsDuplicateAPIKey(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	first := Account{ID: "api-1", KiroApiKey: "ksk_cred_dup", AuthMethod: AuthMethodAPIKey, Enabled: true}
	if err := NormalizeAPIKeyAccount(&first); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if err := AddCredential(first); err != nil {
		t.Fatalf("add credential: %v", err)
	}
	if !CredentialsLoaded() {
		t.Fatal("expected credentials store to be active")
	}
	second := Account{ID: "api-2", KiroApiKey: "ksk_cred_dup", AuthMethod: AuthMethodAPIKey, Enabled: true}
	if err := AddAccount(second); !errors.Is(err, ErrDuplicateKiroAPIKey) {
		t.Fatalf("expected ErrDuplicateKiroAPIKey on the credentials path, got %v", err)
	}
}

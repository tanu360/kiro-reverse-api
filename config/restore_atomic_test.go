package config

import (
	"encoding/json"
	"kiro-proxy/db"
	"testing"
	"time"
)

func TestRestoreAndConcurrentUsageSaveKeepRestoredConfig(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	cfgLock.Lock()
	cfg.ApiKeys = []ApiKeyEntry{{ID: "key", Enabled: true}}
	restored := *cfg
	err := saveLocked()
	cfgLock.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	restored.Port = 9999
	credLock.Lock()
	done := make(chan error, 1)
	go func() { done <- writeRestoredConfig(&parsedBackup{config: restored}) }()
	// Restore must hold cfgLock while waiting for credentials; it cannot publish disk early.
	deadline := time.Now().Add(time.Second)
	for cfgLock.TryRLock() {
		cfgLock.RUnlock()
		if time.Now().After(deadline) {
			credLock.Unlock()
			t.Fatal("restore did not acquire config lock")
		}
		time.Sleep(time.Millisecond)
	}
	raw, _, err := getSetting("config")
	if err != nil {
		credLock.Unlock()
		t.Fatal(err)
	}
	var before Config
	json.Unmarshal([]byte(raw), &before)
	usage := make(chan error, 1)
	go func() { usage <- RecordApiKeyUsage("key", 1, 0) }()
	credLock.Unlock()
	if before.Port == 9999 {
		t.Fatal("restore wrote config before taking credential lock")
	}
	for _, ch := range []chan error{done, usage} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("deadlock")
		}
	}
	if GetPort() != 9999 {
		t.Fatalf("restore lost: port=%d", GetPort())
	}
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPort() != 9999 {
		t.Fatal("restored port not persisted")
	}
}
func TestRestoreTransactionRollback(t *testing.T) {
	if err := Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	old := GetPassword()
	restored := *Get()
	restored.Password = "different"
	restored.Port = 9999
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.Exec(`CREATE TRIGGER reject_restore BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT,'test failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRestoredConfig(&parsedBackup{config: restored, credentialsLoaded: true, credentials: []Account{{ID: "new"}}}); err == nil {
		t.Fatal("restore should fail")
	}
	if GetPassword() != old || GetPort() == 9999 {
		t.Fatal("published failed restore")
	}
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != old || GetPort() == 9999 {
		t.Fatal("disk partially restored")
	}
}
func TestRestoreCredentialModes(t *testing.T) {
	if err := Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	//! Either backup layout restores into the accounts table.
	for _, loaded := range []bool{true, false, true} {
		backup := *Get()
		backup.Accounts = []Account{{ID: "in-config"}}
		if err := writeRestoredConfig(&parsedBackup{config: backup, credentialsLoaded: loaded, credentials: []Account{{ID: "restored"}}}); err != nil {
			t.Fatal(err)
		}
		want := "in-config"
		if loaded {
			want = "restored"
		}
		for _, stage := range []string{"memory", "persisted"} {
			if stage == "persisted" {
				if err := Load(); err != nil {
					t.Fatal(err)
				}
				if err := LoadCredentials(); err != nil {
					t.Fatal(err)
				}
			}
			got := GetAccounts()
			if !CredentialsLoaded() || len(got) != 1 || got[0].ID != want {
				t.Fatalf("%s accounts after restoring loaded=%v: %+v", stage, loaded, got)
			}
			if n := len(Get().Accounts); n != 0 {
				t.Fatalf("%s config still holds %d accounts", stage, n)
			}
		}
	}
}

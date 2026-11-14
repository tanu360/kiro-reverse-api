package config

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"kiro-proxy/db"
)

func rowsTestAccounts() []Account {
	return []Account{
		{ID: "a", Email: "a@example.com", RefreshToken: "refresh-a", Enabled: true},
		{ID: "b", Email: "b@example.com", RefreshToken: "refresh-b", Enabled: true},
		{ID: "c", Email: "c@example.com", RefreshToken: "refresh-c", Enabled: true},
	}
}

// totalChanges is the number of rows the one DB connection has changed so far.
func totalChanges(t *testing.T) int {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	var n int
	if err := d.QueryRow(`SELECT total_changes()`).Scan(&n); err != nil {
		t.Fatalf("total_changes: %v", err)
	}
	return n
}

func accountRowCount(t *testing.T) int {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM accounts`).Scan(&n); err != nil {
		t.Fatalf("count accounts: %v", err)
	}
	return n
}

func accountIDs(list []Account) []string {
	ids := make([]string, len(list))
	for i := range list {
		ids[i] = list[i].ID
	}
	return ids
}

func sameIDs(got []Account, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i].ID != want[i] {
			return false
		}
	}
	return true
}

// seedLegacyStore initialises a data dir, then rewrites its settings to the
// layout an older version left: accounts in the config setting or in the
// credentials setting.
func seedLegacyStore(t *testing.T, inConfig bool, accounts []Account) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init: %v", err)
	}
	d, err := db.Get()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM accounts`); err != nil {
		t.Fatalf("clear rows: %v", err)
	}
	raw, _, err := getSetting("config")
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatalf("parse config: %v", err)
	}
	list, _ := json.Marshal(accounts)
	if inConfig {
		stored["accounts"] = json.RawMessage(list)
		_ = setSetting(credentialsLoadedKey, "0")
	} else {
		_ = setSetting(credentialsKey, string(list))
		_ = setSetting(credentialsLoadedKey, "1")
	}
	data, _ := json.Marshal(stored)
	if err := setSetting("config", string(data)); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestAccountsMoveFromConfigSettingToRows(t *testing.T) {
	path := seedLegacyStore(t, true, rowsTestAccounts())
	if err := Init(path); err != nil {
		t.Fatalf("reinit: %v", err)
	}
	if !CredentialsLoaded() || !sameIDs(GetAccounts(), "a", "b", "c") {
		t.Fatalf("accounts after the move = %v", accountIDs(GetAccounts()))
	}
	if n := accountRowCount(t); n != 3 {
		t.Fatalf("account rows = %d, want 3", n)
	}
	raw, _, _ := getSetting("config")
	var stored struct {
		Accounts []Account `json:"accounts"`
	}
	_ = json.Unmarshal([]byte(raw), &stored)
	if len(stored.Accounts) != 0 {
		t.Fatalf("config setting still holds %d accounts", len(stored.Accounts))
	}
	backups, err := ListBackups(true)
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	found := false
	for _, b := range backups {
		found = found || (b.Kind == "manual" && b.Note == accountRowsBackupNote && b.AccountCnt == 3)
	}
	if !found {
		t.Fatalf("no backup of the 3 accounts before the move: %+v", backups)
	}

	if err := Init(path); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if !sameIDs(GetAccounts(), "a", "b", "c") {
		t.Fatalf("accounts after a restart = %v", accountIDs(GetAccounts()))
	}
}

func TestAccountsMoveFromCredentialsSettingToRows(t *testing.T) {
	legacy := rowsTestAccounts()
	legacy[2].ID = "a" //! a duplicate id; the first account keeps it
	path := seedLegacyStore(t, false, legacy)
	if err := Init(path); err != nil {
		t.Fatalf("reinit: %v", err)
	}
	got := GetAccounts()
	if len(got) != 3 || got[0].ID != "a" || got[1].ID != "b" || got[2].ID == "a" || got[2].RefreshToken != "refresh-c" {
		t.Fatalf("accounts after the move = %+v", got)
	}
	if _, ok, _ := getSetting(credentialsKey); ok {
		t.Fatal("the legacy credentials setting is still there")
	}
}

func TestOneAccountChangeWritesOneRow(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init: %v", err)
	}
	for _, acc := range rowsTestAccounts() {
		if err := AddAccount(acc); err != nil {
			t.Fatalf("add %s: %v", acc.ID, err)
		}
	}

	before := totalChanges(t)
	if err := UpdateAccountStats("b", 5, 1, 900, 1.5, 1700000000); err != nil {
		t.Fatalf("stats: %v", err)
	}
	if err := UpdateAccountToken("c", "access-c2", "refresh-c2", 1700003600); err != nil {
		t.Fatalf("token: %v", err)
	}
	if got := totalChanges(t) - before; got != 2 {
		t.Fatalf("two account updates changed %d rows, want 2", got)
	}

	before = totalChanges(t)
	if err := UpdateAccountStats("b", 5, 1, 900, 1.5, 1700000000); err != nil {
		t.Fatalf("same stats: %v", err)
	}
	if got := totalChanges(t) - before; got != 0 {
		t.Fatalf("an update that changes nothing wrote %d rows", got)
	}

	before = totalChanges(t)
	if err := DeleteAccount("a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := totalChanges(t) - before; got != 1 {
		t.Fatalf("deleting the first account changed %d rows, want 1", got)
	}

	if err := LoadCredentials(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := GetAccounts()
	if !sameIDs(got, "b", "c") {
		t.Fatalf("accounts after reload = %v", accountIDs(got))
	}
	if got[0].RequestCount != 5 || got[0].TotalTokens != 900 || got[1].RefreshToken != "refresh-c2" {
		t.Fatalf("updates lost on reload: %+v", got)
	}
}

func TestPlanAccountRowsKeepsOrder(t *testing.T) {
	stored, err := planAccountRows(rowsTestAccounts(), nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	list := rowsTestAccounts()
	moved := []Account{list[2], list[0], list[1], {ID: "d"}}
	next, err := planAccountRows(moved, stored)
	if err != nil {
		t.Fatalf("plan moved: %v", err)
	}
	for i := 1; i < len(moved); i++ {
		if next[moved[i-1].ID].pos >= next[moved[i].ID].pos {
			t.Fatalf("positions out of order: %+v", next)
		}
	}
	if _, err := planAccountRows([]Account{{ID: "x"}, {ID: "x"}}, nil); err == nil {
		t.Fatal("two accounts with one id were accepted")
	}
}

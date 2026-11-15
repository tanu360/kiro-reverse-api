package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"kiro-proxy/logger"
)

// lockedBuffer is a log sink that is safe to write from background saves.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func captureLogs(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	logger.SetOutput(buf)
	t.Cleanup(func() { logger.SetOutput(os.Stderr) })
	return buf
}

func countLines(s, substr string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		if strings.Contains(line, substr) {
			n++
		}
	}
	return n
}

func priorities(accounts []Account) []int {
	out := make([]int, len(accounts))
	for i := range accounts {
		out[i] = accounts[i].Priority
	}
	return out
}

// storeOldConfig saves the running config without the higher-first mark, as a
// version from before the change left it, with accounts holding priorities.
func storeOldConfig(t *testing.T, prios ...int) {
	t.Helper()
	for i, p := range prios {
		if err := AddAccount(Account{ID: string(rune('a' + i)), Enabled: true, Priority: p}); err != nil {
			t.Fatalf("add account: %v", err)
		}
	}
	cfgLock.Lock()
	cfg.PriorityHigherFirst = false
	err := saveLocked()
	cfgLock.Unlock()
	if err != nil {
		t.Fatalf("save old config: %v", err)
	}
}

// restart reads the config and accounts back from the database and runs the
// priority migration, as Init does on start.
func restart(t *testing.T) {
	t.Helper()
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := LoadCredentials(); err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if err := migratePriorityOrder(); err != nil {
		t.Fatalf("migratePriorityOrder: %v", err)
	}
}

func TestNewConfigIsMarkedHigherFirst(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if !Get().PriorityHigherFirst {
		t.Fatal("a new config must be marked higher first, or its first restart would turn its priorities around")
	}
	for _, id := range []string{"a", "b"} {
		if err := AddAccount(Account{ID: id, Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	acc := GetAccounts()[1]
	acc.Priority = 5
	if err := UpdateAccount("b", acc); err != nil {
		t.Fatal(err)
	}
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 5}) {
		t.Fatalf("priorities after a restart = %v, want [0 5] untouched", got)
	}
}

func TestPriorityMigrationKeepsTheOldOrderOnce(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	// Old meaning, lower first: a and d first (0), then b (2), then c (5).
	storeOldConfig(t, 0, 2, 5, 0)
	logs := captureLogs(t)

	restart(t)
	want := []int{5, 3, 0, 5}
	if got := priorities(GetAccounts()); !slices.Equal(got, want) {
		t.Fatalf("migrated priorities = %v, want %v (same order, higher first)", got, want)
	}
	if !Get().PriorityHigherFirst {
		t.Fatal("the config does not record that the migration ran")
	}
	if n := countLines(logs.String(), "Account priorities now go higher first"); n != 1 {
		t.Fatalf("migration logged %d lines, want 1:\n%s", n, logs)
	}

	// Stored, not just in memory, and never run again.
	restart(t)
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, want) {
		t.Fatalf("priorities after more restarts = %v, want %v", got, want)
	}
	raw, _, err := getSetting("config")
	if err != nil {
		t.Fatal(err)
	}
	var stored Config
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatal(err)
	}
	if !stored.PriorityHigherFirst {
		t.Fatal("the mark is not in the stored config")
	}
	if n := countLines(logs.String(), "Account priorities now go higher first"); n != 1 {
		t.Fatalf("migration logged %d lines after more restarts, want 1", n)
	}
}

func TestPriorityMigrationLeavesAllZeroAlone(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	storeOldConfig(t, 0, 0, 0)
	logs := captureLogs(t)
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 0, 0}) {
		t.Fatalf("priorities = %v, want all 0 untouched", got)
	}
	if !Get().PriorityHigherFirst {
		t.Fatal("the config must be marked even when nothing changed, so a later priority is never turned around")
	}
	if n := countLines(logs.String(), "Account priorities now go higher first"); n != 0 {
		t.Fatalf("nothing changed, yet the migration logged:\n%s", logs)
	}

	// A priority set after the migration stays as set.
	acc := GetAccounts()[2]
	acc.Priority = 9
	if err := UpdateAccount("c", acc); err != nil {
		t.Fatal(err)
	}
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 0, 9}) {
		t.Fatalf("priorities = %v, want [0 0 9]", got)
	}
}

// Accounts still in the config itself (before the accounts table) migrate the same way.
func TestPriorityMigrationOfAccountsInTheConfig(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceCredentials(false, nil); err != nil {
		t.Fatal(err)
	}
	storeOldConfig(t, 3, 0)
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 3}) {
		t.Fatalf("priorities = %v, want [0 3]", got)
	}
	restart(t)
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 3}) {
		t.Fatalf("priorities after a second restart = %v, want [0 3]", got)
	}
}

func TestRestoringAnOldBackupTurnsItsPrioritiesAround(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	old := *Get()
	old.PriorityHigherFirst = false
	accounts := []Account{{ID: "a", Enabled: true, Priority: 1}, {ID: "b", Enabled: true}}
	if err := writeRestoredConfig(&parsedBackup{config: old, credentialsLoaded: true, credentials: accounts}); err != nil {
		t.Fatal(err)
	}
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{0, 1}) {
		t.Fatalf("restored old backup priorities = %v, want [0 1]", got)
	}
	if !Get().PriorityHigherFirst {
		t.Fatal("the restored config must carry the mark")
	}
	if accounts[0].Priority != 1 {
		t.Fatal("the backup's own list was written")
	}

	// A backup taken after the change restores as it is.
	current := *Get()
	if err := writeRestoredConfig(&parsedBackup{config: current, credentialsLoaded: true, credentials: accounts}); err != nil {
		t.Fatal(err)
	}
	if got := priorities(GetAccounts()); !slices.Equal(got, []int{1, 0}) {
		t.Fatalf("restored new backup priorities = %v, want [1 0]", got)
	}
}

func TestHigherFirstPriorities(t *testing.T) {
	for _, tc := range []struct {
		in, want []int
	}{
		{[]int{0, 1, 2}, []int{2, 1, 0}},
		{[]int{4, 4, 1}, []int{0, 0, 3}},
		{[]int{0, 0}, []int{0, 0}},
		{[]int{999, 0}, []int{0, 999}},
		{[]int{-3, 2}, []int{5, 0}},
		{nil, nil},
	} {
		in := make([]Account, len(tc.in))
		for i, p := range tc.in {
			in[i].Priority = p
		}
		out, _ := higherFirstPriorities(in)
		if got := priorities(out); !slices.Equal(got, tc.want) && !(len(got) == 0 && len(tc.want) == 0) {
			t.Fatalf("higherFirstPriorities(%v) = %v, want %v", tc.in, got, tc.want)
		}
		if got := priorities(in); !slices.Equal(got, tc.in) && len(tc.in) > 0 {
			t.Fatalf("input changed to %v", got)
		}
	}
}

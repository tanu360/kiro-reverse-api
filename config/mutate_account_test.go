package config

import (
	"path/filepath"
	"sync"
	"testing"
)

func mutateAccountInStore(t *testing.T, separate bool) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	add := AddAccount
	if separate {
		add = AddCredential
	}
	if err := add(Account{ID: "one", Enabled: true, Priority: 2, Weight: 5, Nickname: "Main"}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var notified []string
	SetAccountsChangedHook(func(id string) {
		mu.Lock()
		notified = append(notified, id)
		mu.Unlock()
	})
	t.Cleanup(func() { SetAccountsChangedHook(nil) })

	// An admin edit lands after the caller took its copy; the mutate sees the stored row.
	stored := GetAccounts()[0]
	stored.Priority, stored.Nickname = 7, "Renamed"
	if err := UpdateAccount("one", stored); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	notified = nil
	mu.Unlock()

	changed, err := MutateAccount("one", func(acc *Account) bool {
		acc.Enabled = false
		acc.BanStatus = "BANNED"
		return true
	})
	if err != nil || !changed {
		t.Fatalf("mutate: changed=%v err=%v", changed, err)
	}
	got := GetAccounts()[0]
	if got.Enabled || got.BanStatus != "BANNED" || got.Priority != 7 || got.Nickname != "Renamed" || got.Weight != 5 {
		t.Fatalf("stored = %+v", got)
	}

	// A mutate that reports no change neither saves nor notifies, even if it touched the row.
	changed, err = MutateAccount("one", func(acc *Account) bool {
		acc.Nickname = "discarded"
		return false
	})
	if err != nil || changed {
		t.Fatalf("no-op mutate: changed=%v err=%v", changed, err)
	}
	if got := GetAccounts()[0]; got.Nickname != "Renamed" {
		t.Fatalf("a no-op mutate kept its edit: %q", got.Nickname)
	}
	mu.Lock()
	if len(notified) != 1 || notified[0] != "one" {
		t.Fatalf("notified = %v, want one notice for the one change", notified)
	}
	mu.Unlock()

	if _, err := MutateAccount("gone", func(*Account) bool { return true }); err == nil {
		t.Fatal("a missing account must be an error")
	}
}

func TestMutateAccountChangesOnlyWhatItSets(t *testing.T) {
	t.Run("config", func(t *testing.T) { mutateAccountInStore(t, false) })
	t.Run("credentials", func(t *testing.T) { mutateAccountInStore(t, true) })
}

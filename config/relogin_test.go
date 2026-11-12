package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func replaceLoginInStore(t *testing.T, separate bool) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	add := AddAccount
	if separate {
		add = AddCredential
	}
	for _, acc := range []Account{
		{ID: "one", Nickname: "keep", AccessToken: "old", RefreshToken: "old-refresh"},
		{ID: "two", AccessToken: "other"},
	} {
		if err := add(acc); err != nil {
			t.Fatal(err)
		}
	}
	var notified []string
	SetAccountsChangedHook(func(id string) { notified = append(notified, id) })
	t.Cleanup(func() { SetAccountsChangedHook(nil) })

	saved, err := ReplaceAccountLogin("one", func(current Account, others []Account) (Account, error) {
		if len(others) != 1 || others[0].ID != "two" {
			t.Fatalf("others = %+v", others)
		}
		current.ID = "changed"
		current.AccessToken = "new"
		current.RefreshToken = "new-refresh"
		return current, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != "one" || saved.AccessToken != "new" {
		t.Fatalf("saved = %+v", saved)
	}
	// Unlike UpdateAccount, the credentials are replaced, not preserved.
	got := *findStored(t, "one")
	if got.AccessToken != "new" || got.RefreshToken != "new-refresh" || got.Nickname != "keep" {
		t.Fatalf("stored = %+v", got)
	}
	if len(GetAccounts()) != 2 {
		t.Fatalf("accounts = %+v", GetAccounts())
	}
	if len(notified) != 1 || notified[0] != "one" {
		t.Fatalf("notified = %v", notified)
	}

	// It is persisted: a reload from the database sees it.
	if separate {
		if err := LoadCredentials(); err != nil {
			t.Fatal(err)
		}
	} else if err := Load(); err != nil {
		t.Fatal(err)
	}
	if got := *findStored(t, "one"); got.AccessToken != "new" {
		t.Fatalf("after reload = %+v", got)
	}

	if _, err := ReplaceAccountLogin("missing", func(current Account, _ []Account) (Account, error) {
		t.Fatal("fn ran for a missing account")
		return current, nil
	}); err == nil {
		t.Fatal("missing account: want an error")
	}
}

func findStored(t *testing.T, id string) *Account {
	t.Helper()
	for _, acc := range GetAccounts() {
		if acc.ID == id {
			return &acc
		}
	}
	t.Fatalf("account %s not found", id)
	return nil
}

func TestReplaceAccountLoginConfigStore(t *testing.T) {
	replaceLoginInStore(t, false)
}

func TestReplaceAccountLoginCredentialStore(t *testing.T) {
	replaceLoginInStore(t, true)
}

func TestReplaceAccountLoginFnErrorSavesNothing(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if err := AddAccount(Account{ID: "one", AccessToken: "old"}); err != nil {
		t.Fatal(err)
	}
	notified := 0
	SetAccountsChangedHook(func(string) { notified++ })
	t.Cleanup(func() { SetAccountsChangedHook(nil) })
	refused := errors.New("refused")
	_, err := ReplaceAccountLogin("one", func(current Account, _ []Account) (Account, error) {
		current.AccessToken = "new"
		return current, refused
	})
	if !errors.Is(err, refused) {
		t.Fatalf("err = %v", err)
	}
	if got := *findStored(t, "one"); got.AccessToken != "old" {
		t.Fatalf("stored = %+v", got)
	}
	if notified != 0 {
		t.Fatalf("notified %d times", notified)
	}
}

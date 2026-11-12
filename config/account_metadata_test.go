package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestNormalizeAccountTags(t *testing.T) {
	long := strings.Repeat("é", MaxAccountTagRunes+5)
	got := NormalizeAccountTags([]string{
		"  team  a ", "Team A", "", "  ", "back\x00up", "line\nbreak", long, "团队",
	})
	want := []string{"team a", "backup", "line break", strings.Repeat("é", MaxAccountTagRunes), "团队"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NormalizeAccountTags = %q, want %q", got, want)
	}

	var many []string
	for i := 0; i < MaxAccountTags+3; i++ {
		many = append(many, fmt.Sprintf("t%d", i))
	}
	if got := NormalizeAccountTags(many); len(got) != MaxAccountTags || got[0] != "t0" || got[MaxAccountTags-1] != "t9" {
		t.Fatalf("expected the first %d tags, got %q", MaxAccountTags, got)
	}
	// The UI splits its tag field on these, so a stored tag must not hold one.
	if got := NormalizeAccountTags([]string{"eu,west", "東京、大阪", "a，b", ", ,"}); !reflect.DeepEqual(got, []string{"eu west", "東京 大阪", "a b"}) {
		t.Fatalf("separators must become spaces, got %q", got)
	}
	if got := NormalizeAccountTags([]string{" ", ""}); got != nil {
		t.Fatalf("no tag left must be nil, got %#v", got)
	}

	input := []string{"a", "b"}
	out := NormalizeAccountTags(input)
	out[0] = "changed"
	if input[0] != "a" {
		t.Fatal("NormalizeAccountTags must return a fresh slice")
	}
}

func TestNormalizeAccountNotes(t *testing.T) {
	if got := NormalizeAccountNotes("  line one\r\nline\ttwo\rthree\x07  "); got != "line one\nline\ttwo\nthree" {
		t.Fatalf("NormalizeAccountNotes = %q", got)
	}
	long := strings.Repeat("界", MaxAccountNotesRunes+10)
	got := NormalizeAccountNotes(long)
	if n := len([]rune(got)); n != MaxAccountNotesRunes {
		t.Fatalf("notes cut to %d runes, want %d", n, MaxAccountNotesRunes)
	}
	if !strings.HasPrefix(long, got) {
		t.Fatal("notes must be cut on a rune boundary")
	}
}

func TestAddRemoveAccountTag(t *testing.T) {
	tags := []string{"alpha", "Beta"}
	same, err := AddAccountTag(tags, " BETA ")
	if err != nil || !reflect.DeepEqual(same, tags) {
		t.Fatalf("adding an existing tag in another case must be a no-op: %q %v", same, err)
	}
	added, err := AddAccountTag(tags, "gamma")
	if err != nil || !reflect.DeepEqual(added, []string{"alpha", "Beta", "gamma"}) {
		t.Fatalf("add = %q %v", added, err)
	}
	if !reflect.DeepEqual(tags, []string{"alpha", "Beta"}) {
		t.Fatal("AddAccountTag modified its input")
	}

	var full []string
	for i := 0; i < MaxAccountTags; i++ {
		full = append(full, fmt.Sprintf("t%d", i))
	}
	if _, err := AddAccountTag(full, "one-more"); !errors.Is(err, ErrAccountTagLimit) {
		t.Fatalf("expected ErrAccountTagLimit, got %v", err)
	}
	if _, err := AddAccountTag(full, "T3"); err != nil {
		t.Fatalf("an existing tag on a full list is still a no-op, got %v", err)
	}

	removed := RemoveAccountTag(added, "BETA")
	if !reflect.DeepEqual(removed, []string{"alpha", "gamma"}) {
		t.Fatalf("remove = %q", removed)
	}
	if !reflect.DeepEqual(added, []string{"alpha", "Beta", "gamma"}) {
		t.Fatal("RemoveAccountTag modified its input")
	}
	if got := RemoveAccountTag([]string{"x"}, "x"); got != nil {
		t.Fatalf("removing the last tag must leave nil, got %#v", got)
	}
}

// metadataStores runs fn once with accounts in the config and once in the credentials store.
func metadataStores(t *testing.T, fn func(t *testing.T, add func(Account) error, reload func() error)) {
	for _, separate := range []bool{false, true} {
		name := "config"
		if separate {
			name = "credentials"
		}
		t.Run(name, func(t *testing.T) {
			if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatal(err)
			}
			add := AddAccount
			reload := Load
			if separate {
				add = func(a Account) error {
					normalizeAccountMetadata(&a)
					return AddCredential(a)
				}
				reload = LoadCredentials
			}
			fn(t, add, reload)
		})
	}
}

func TestEditAccountMetadataPersistsInBothStores(t *testing.T) {
	metadataStores(t, func(t *testing.T, add func(Account) error, reload func() error) {
		if err := add(Account{ID: "one", Nickname: "nick"}); err != nil {
			t.Fatal(err)
		}
		err := EditAccountMetadata("one", func(notes string, tags []string) (string, []string, error) {
			return " owner: ops@example.com \r\n", []string{"team-a", "Team-A", " backup "}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := reload(); err != nil {
			t.Fatal(err)
		}
		got := GetAccounts()[0]
		if got.Notes != "owner: ops@example.com" || !reflect.DeepEqual(got.Tags, []string{"team-a", "backup"}) || got.Nickname != "nick" {
			t.Fatalf("metadata not persisted: notes=%q tags=%q nickname=%q", got.Notes, got.Tags, got.Nickname)
		}

		if err := EditAccountMetadata("missing", func(n string, tags []string) (string, []string, error) {
			return n, tags, nil
		}); err == nil || !strings.Contains(err.Error(), "account not found") {
			t.Fatalf("unknown id must fail, got %v", err)
		}
		wantErr := errors.New("edit refused")
		if err := EditAccountMetadata("one", func(string, []string) (string, []string, error) {
			return "", nil, wantErr
		}); !errors.Is(err, wantErr) {
			t.Fatalf("edit error must come back, got %v", err)
		}
		if got := GetAccounts()[0]; got.Notes == "" || len(got.Tags) != 2 {
			t.Fatalf("a refused edit changed the account: %+v", got)
		}
	})
}

func TestConcurrentTagEditsKeepEveryTag(t *testing.T) {
	metadataStores(t, func(t *testing.T, add func(Account) error, _ func() error) {
		if err := add(Account{ID: "one"}); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		for i := 0; i < MaxAccountTags; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_ = EditAccountMetadata("one", func(notes string, tags []string) (string, []string, error) {
					next, err := AddAccountTag(tags, fmt.Sprintf("tag-%d", i))
					return notes, next, err
				})
			}(i)
		}
		wg.Wait()
		if got := GetAccounts()[0].Tags; len(got) != MaxAccountTags {
			t.Fatalf("concurrent adds lost tags: %q", got)
		}
	})
}

func TestStaleUpdatePreservesAccountMetadata(t *testing.T) {
	metadataStores(t, func(t *testing.T, add func(Account) error, _ func() error) {
		stale := Account{ID: "one", AccessToken: "a", RefreshToken: "r", Enabled: true}
		if err := add(stale); err != nil {
			t.Fatal(err)
		}
		if err := EditAccountMetadata("one", func(string, []string) (string, []string, error) {
			return "keep me", []string{"keep"}, nil
		}); err != nil {
			t.Fatal(err)
		}

		// Every writer that starts from a snapshot taken before the edit.
		stale.BanStatus = "BANNED"
		stale.Notes = ""
		stale.Tags = []string{"stale"}
		if err := UpdateAccount("one", stale); err != nil {
			t.Fatal(err)
		}
		if err := UpdateAccountToken("one", "a2", "r2", 99); err != nil {
			t.Fatal(err)
		}
		if err := UpdateAccountInfo("one", AccountInfo{Email: "new@example.com", SubscriptionType: "FREE"}); err != nil {
			t.Fatal(err)
		}
		if err := SetAccountBanStatus("one", "ACTIVE", ""); err != nil {
			t.Fatal(err)
		}
		if err := SetAccountEnabled("one", false); err != nil {
			t.Fatal(err)
		}
		if err := UpdateAccountStats("one", 3, 1, 100, 0.5, 42); err != nil {
			t.Fatal(err)
		}

		got := GetAccounts()[0]
		if got.Notes != "keep me" || !reflect.DeepEqual(got.Tags, []string{"keep"}) {
			t.Fatalf("metadata lost to a stale update: notes=%q tags=%q", got.Notes, got.Tags)
		}
		if got.Email != "new@example.com" || got.AccessToken != "a2" || got.RequestCount != 3 || got.Enabled {
			t.Fatalf("the other updates did not land: %+v", got)
		}
	})
}

func TestAddAccountNormalizesMetadata(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	err := AddAccount(Account{
		ID:    "one",
		Notes: "  " + strings.Repeat("n", MaxAccountNotesRunes+1),
		Tags:  []string{"A", "a", "", strings.Repeat("x", 40)},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := GetAccounts()[0]
	if len(got.Notes) != MaxAccountNotesRunes || !reflect.DeepEqual(got.Tags, []string{"A", strings.Repeat("x", MaxAccountTagRunes)}) {
		t.Fatalf("AddAccount kept raw metadata: notes=%d tags=%q", len(got.Notes), got.Tags)
	}
}

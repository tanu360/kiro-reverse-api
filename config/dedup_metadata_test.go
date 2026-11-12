package config

import (
	"reflect"
	"testing"
)

func TestUpsertAccountKeepsNotesAndTagsAndAddsTheLogins(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		if err := AddAccount(Account{
			ID: "keep", AuthMethod: "social", Provider: "Google", Email: "dev@example.com",
			RefreshToken: "rt-old", Notes: "primary seat", Tags: []string{"team-a"}, Priority: 4,
		}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, updated, err := UpsertAccount(Account{
			ID: "new", AuthMethod: "social", Provider: "Google", Email: "dev@example.com",
			RefreshToken: "rt-new", Notes: "imported note", Tags: []string{" Team-A ", "backup"},
		})
		if err != nil || !updated {
			t.Fatalf("upsert updated=%v err=%v", updated, err)
		}
		got := GetAccounts()[0]
		if got.Notes != "primary seat" || !reflect.DeepEqual(got.Tags, []string{"team-a", "backup"}) {
			t.Fatalf("notes=%q tags=%q, want the stored note and team-a, backup", got.Notes, got.Tags)
		}
		if got.Priority != 4 || got.RefreshToken != "rt-new" {
			t.Fatalf("priority=%d refresh=%q, want 4 and the new token", got.Priority, got.RefreshToken)
		}
	})
}

func TestUpsertAccountNormalizesMetadataOfANewAccount(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		stored, updated, err := UpsertAccount(Account{
			ID: "new", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", RefreshToken: "rt",
			Notes: " line one\r\nline two ", Tags: []string{"Ops", "ops", " ", "b,c"},
		})
		if err != nil || updated {
			t.Fatalf("upsert updated=%v err=%v", updated, err)
		}
		want := []string{"Ops", "b c"}
		if stored.Notes != "line one\nline two" || !reflect.DeepEqual(stored.Tags, want) {
			t.Fatalf("returned notes=%q tags=%q", stored.Notes, stored.Tags)
		}
		if got := GetAccounts()[0]; got.Notes != stored.Notes || !reflect.DeepEqual(got.Tags, want) {
			t.Fatalf("stored notes=%q tags=%q", got.Notes, got.Tags)
		}
	})
}

func TestMergeAccountsKeepsDonorNotesAndTags(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		for _, a := range []Account{
			{ID: "keep", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-1", Notes: "main", Tags: []string{"x"}},
			{ID: "dup", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-1", Notes: "spare login", Tags: []string{"X", "y"}},
			{ID: "dup2", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-1", Notes: "main"},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		if _, err := MergeAccounts("keep", []string{"dup", "dup2"}, AccountCounters{}); err != nil {
			t.Fatalf("merge: %v", err)
		}
		got := GetAccounts()[0]
		if got.Notes != "main\n\nspare login" || !reflect.DeepEqual(got.Tags, []string{"x", "y"}) {
			t.Fatalf("notes=%q tags=%q, want both notes once and tags x, y", got.Notes, got.Tags)
		}
	})
}

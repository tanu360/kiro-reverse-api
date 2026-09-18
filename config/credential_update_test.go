package config

import (
	"path/filepath"
	"testing"
)

func TestStatusUpdatePreservesRotatedCredentialsInBothStores(t *testing.T) {
	for _, separate := range []bool{false, true} {
		name := "config"
		if separate {
			name = "credentials"
		}
		t.Run(name, func(t *testing.T) {
			if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatal(err)
			}
			stale := Account{ID: "one", AccessToken: "old", RefreshToken: "old-refresh"}
			add := AddAccount
			if separate {
				add = AddCredential
			}
			if err := add(stale); err != nil {
				t.Fatal(err)
			}
			if err := UpdateAccountToken(stale.ID, "new", "new-refresh", 123); err != nil {
				t.Fatal(err)
			}
			if err := UpdateAccountProfileArn(stale.ID, "new-profile"); err != nil {
				t.Fatal(err)
			}
			stale.Nickname = "renamed"
			if err := UpdateAccount(stale.ID, stale); err != nil {
				t.Fatal(err)
			}
			got := GetAccounts()[0]
			if got.AccessToken != "new" || got.RefreshToken != "new-refresh" || got.ProfileArn != "new-profile" || got.ExpiresAt != 123 || got.Nickname != "renamed" {
				t.Fatalf("credential or admin fields lost: %+v", got)
			}
			if err := DeleteAccount(stale.ID); err != nil {
				t.Fatal(err)
			}
			if err := UpdateAccountToken(stale.ID, "resurrected", "", 0); err == nil {
				t.Fatal("missing account update succeeded")
			}
			if len(GetAccounts()) != 0 {
				t.Fatal("deleted account resurrected")
			}
		})
	}
}

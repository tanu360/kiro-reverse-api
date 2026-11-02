package config

import (
	"path/filepath"
	"testing"
)

const (
	pinnedTestArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/PINNED"
	autoTestArn   = "arn:aws:codewhisperer:us-east-1:123456789012:profile/AUTO"
)

func TestPinnedProfileArnSurvivesAutomaticUpdatesInBothStores(t *testing.T) {
	for _, separate := range []bool{false, true} {
		name := "config"
		if separate {
			name = "credentials"
		}
		t.Run(name, func(t *testing.T) {
			if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatal(err)
			}
			acc := Account{ID: "one", AccessToken: "a", RefreshToken: "r", ProfileArn: autoTestArn}
			add := AddAccount
			if separate {
				add = AddCredential
			}
			if err := add(acc); err != nil {
				t.Fatal(err)
			}

			if err := PinAccountProfileArn(acc.ID, pinnedTestArn); err != nil {
				t.Fatal(err)
			}
			got := GetAccounts()[0]
			if got.ProfileArn != pinnedTestArn || !got.ProfileArnPinned {
				t.Fatalf("pin not stored: %+v", got)
			}

			if err := UpdateAccountProfileArn(acc.ID, autoTestArn); err != nil {
				t.Fatal(err)
			}
			if got := GetAccounts()[0]; got.ProfileArn != pinnedTestArn || !got.ProfileArnPinned {
				t.Fatalf("automatic update replaced pinned ARN: %+v", got)
			}

			stale := acc
			stale.Nickname = "renamed"
			if err := UpdateAccount(acc.ID, stale); err != nil {
				t.Fatal(err)
			}
			if got := GetAccounts()[0]; got.ProfileArn != pinnedTestArn || !got.ProfileArnPinned || got.Nickname != "renamed" {
				t.Fatalf("admin update dropped the pin: %+v", got)
			}

			if err := PinAccountProfileArn(acc.ID, ""); err != nil {
				t.Fatal(err)
			}
			if got := GetAccounts()[0]; got.ProfileArn != "" || got.ProfileArnPinned {
				t.Fatalf("unpin did not return to automatic: %+v", got)
			}
			if err := UpdateAccountProfileArn(acc.ID, autoTestArn); err != nil {
				t.Fatal(err)
			}
			if got := GetAccounts()[0]; got.ProfileArn != autoTestArn {
				t.Fatalf("automatic update ignored after unpin: %+v", got)
			}

			if err := PinAccountProfileArn("missing", pinnedTestArn); err == nil {
				t.Fatal("pinning a missing account succeeded")
			}
		})
	}
}

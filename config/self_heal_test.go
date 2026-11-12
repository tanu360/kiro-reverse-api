package config

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestSelfHealSettingsDefaultsAndRanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if !GetSelfHeal() || GetSelfHealIntervalSec() != 300 || GetSelfHealInterval() != 5*time.Minute || GetSelfHealMaxRounds() != 5 {
		t.Fatalf("defaults = %v/%d/%d, want true/300/5", GetSelfHeal(), GetSelfHealIntervalSec(), GetSelfHealMaxRounds())
	}

	for _, bad := range []int{0, 29, MaxSelfHealIntervalSec + 1} {
		if err := UpdateSelfHealSettings(nil, &bad, nil); !errors.Is(err, ErrSelfHealIntervalRange) {
			t.Fatalf("interval %d: err = %v, want range error", bad, err)
		}
	}
	for _, bad := range []int{-1, MaxSelfHealMaxRounds + 1} {
		if err := UpdateSelfHealSettings(nil, nil, &bad); !errors.Is(err, ErrSelfHealRoundsRange) {
			t.Fatalf("rounds %d: err = %v, want range error", bad, err)
		}
	}
	off, interval, badRounds := false, 60, -1
	if err := UpdateSelfHealSettings(&off, &interval, &badRounds); err == nil {
		t.Fatal("a patch with one bad value must be rejected")
	}
	if !GetSelfHeal() || GetSelfHealIntervalSec() != 300 {
		t.Fatal("a rejected patch was partly applied")
	}

	zero := 0
	if err := UpdateSelfHealSettings(&off, &interval, &zero); err != nil {
		t.Fatalf("valid patch: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if GetSelfHeal() || GetSelfHealIntervalSec() != 60 || GetSelfHealMaxRounds() != 0 {
		t.Fatalf("persisted = %v/%d/%d, want false/60/0 (0 = no limit)", GetSelfHeal(), GetSelfHealIntervalSec(), GetSelfHealMaxRounds())
	}

	cfgLock.Lock()
	cfg.SelfHealIntervalSec = 5
	tooMany := 1000
	cfg.SelfHealMaxRounds = &tooMany
	cfgLock.Unlock()
	if GetSelfHealIntervalSec() != MinSelfHealIntervalSec || GetSelfHealMaxRounds() != MaxSelfHealMaxRounds {
		t.Fatal("out-of-range stored values must read as the bounds")
	}
}

func TestSelfHealStateRoundTrip(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if got, err := LoadSelfHealState(); err != nil || got != (SelfHealState{}) {
		t.Fatalf("fresh state = %+v, %v; want zero", got, err)
	}
	want := SelfHealState{LastHealAt: 1700000000, Rounds: 3, Halted: true, HaltedAt: 1700000300, LastHealed: 4}
	if err := SaveSelfHealState(want); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadSelfHealState(); err != nil || got != want {
		t.Fatalf("loaded = %+v, %v; want %+v", got, err, want)
	}
}

func TestReenableBannedAccountsOnlyLiftsTheGivenReason(t *testing.T) {
	const reason = "Authentication failed - token invalid or expired"
	for _, credentialsMode := range []bool{false, true} {
		if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
			t.Fatalf("init config: %v", err)
		}
		accounts := []Account{
			{ID: "auth", BanStatus: "BANNED", BanReason: reason, BanTime: 9},
			{ID: "suspended", BanStatus: "BANNED", BanReason: "AWS temporarily suspended - unusual user activity detected"},
			{ID: "manual", BanStatus: "DISABLED", BanReason: reason},
			{ID: "silent", BanStatus: "BANNED", BanReason: reason, Silent: true},
			{ID: "not-asked", BanStatus: "BANNED", BanReason: reason},
		}
		if credentialsMode {
			if err := ReplaceCredentials(true, accounts); err != nil {
				t.Fatal(err)
			}
		} else {
			for _, acc := range accounts {
				if err := AddAccount(acc); err != nil {
					t.Fatal(err)
				}
			}
		}
		changed, err := ReenableBannedAccounts([]string{"auth", "suspended", "manual", "silent", "missing"}, reason)
		if err != nil || !slices.Equal(changed, []string{"auth"}) {
			t.Fatalf("credentials=%v: changed = %v, %v; want [auth]", credentialsMode, changed, err)
		}
		for _, acc := range GetAccounts() {
			lifted := acc.Enabled && acc.BanStatus == "ACTIVE" && acc.BanReason == "" && acc.BanTime == 0
			if lifted != (acc.ID == "auth") {
				t.Fatalf("credentials=%v: %s = %+v", credentialsMode, acc.ID, acc)
			}
		}
	}
}

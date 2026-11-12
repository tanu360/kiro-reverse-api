package config

import (
	"path/filepath"
	"testing"
	"time"
)

func TestUsageRefreshIntervalDefaultsTo30(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if got := GetUsageRefreshIntervalMinutes(); got != 30 {
		t.Fatalf("default interval = %d, want 30", got)
	}
	if got := GetUsageRefreshInterval(); got != 30*time.Minute {
		t.Fatalf("default duration = %s, want 30m", got)
	}
}

func TestUsageRefreshIntervalRejectsOutOfRange(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateUsageRefreshIntervalMinutes(15); err != nil {
		t.Fatalf("set 15: %v", err)
	}
	for _, bad := range []int{-1, 1, 4, 1441} {
		if err := UpdateUsageRefreshIntervalMinutes(bad); err == nil {
			t.Fatalf("UpdateUsageRefreshIntervalMinutes(%d) must be rejected", bad)
		}
	}
	if got := GetUsageRefreshIntervalMinutes(); got != 15 {
		t.Fatalf("a rejected value changed the interval to %d", got)
	}
	for _, ok := range []int{0, 5, 1440} {
		if !ValidUsageRefreshIntervalMinutes(ok) {
			t.Fatalf("%d must be accepted", ok)
		}
	}
}

func TestUsageRefreshIntervalOffPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	for _, want := range []int{0, 15} {
		if err := UpdateUsageRefreshIntervalMinutes(want); err != nil {
			t.Fatalf("set %d: %v", want, err)
		}
		if err := Init(path); err != nil {
			t.Fatalf("reload config: %v", err)
		}
		//! 0 is a real value (off): omitempty on a plain int would drop it and read back 30.
		if got := GetUsageRefreshIntervalMinutes(); got != want {
			t.Fatalf("after reload the interval is %d, want %d", got, want)
		}
	}
	if got := GetUsageRefreshInterval(); got != 15*time.Minute {
		t.Fatalf("duration = %s, want 15m", got)
	}
}

func TestUsageRefreshIntervalClampsStoredValue(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	cases := []struct{ stored, want int }{
		{-5, 30},
		{0, 0},
		{2, 5},
		{45, 45},
		{5000, 1440},
	}
	for _, c := range cases {
		n := c.stored
		cfgLock.Lock()
		cfg.UsageRefreshIntervalMinutes = &n
		cfgLock.Unlock()
		if got := GetUsageRefreshIntervalMinutes(); got != c.want {
			t.Errorf("stored %d reads as %d, want %d", c.stored, got, c.want)
		}
	}
}

package config

import (
	"path/filepath"
	"testing"
)

func TestLogRetentionDaysDefaultAndBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if got := GetLogRetentionDays(); got != DefaultLogRetentionDays {
		t.Fatalf("unset retention = %d, want the default %d", got, DefaultLogRetentionDays)
	}

	// 0 (keep forever) is a value of its own, not "unset".
	if err := UpdateLogRetentionDays(0); err != nil {
		t.Fatalf("set 0: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if got := GetLogRetentionDays(); got != 0 {
		t.Fatalf("persisted retention = %d, want 0", got)
	}

	for _, bad := range []int{-1, MaxLogRetentionDays + 1} {
		if err := UpdateLogRetentionDays(bad); err == nil {
			t.Fatalf("UpdateLogRetentionDays(%d) must be rejected", bad)
		}
	}
	if err := UpdateLogRetentionDays(MaxLogRetentionDays); err != nil {
		t.Fatalf("set max: %v", err)
	}
	if got := GetLogRetentionDays(); got != MaxLogRetentionDays {
		t.Fatalf("retention = %d, want %d", got, MaxLogRetentionDays)
	}

	for stored, want := range map[int]int{-5: 0, 99999: MaxLogRetentionDays} {
		cfgLock.Lock()
		cfg.LogRetentionDays = &stored
		cfgLock.Unlock()
		if got := GetLogRetentionDays(); got != want {
			t.Fatalf("stored %d reads as %d, want %d", stored, got, want)
		}
	}
}

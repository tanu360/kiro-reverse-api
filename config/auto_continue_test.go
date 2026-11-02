package config

import (
	"path/filepath"
	"testing"
)

func TestAutoContinueDefaultsOffWithThreeContinuations(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if GetAutoContinue() {
		t.Fatalf("auto-continue must be off by default")
	}
	if got := GetAutoContinueMax(); got != 3 {
		t.Fatalf("default max continuations = %d, want 3", got)
	}
}

func TestAutoContinueSettingsPersistAndStayBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateAutoContinue(true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if err := UpdateAutoContinueMax(7); err != nil {
		t.Fatalf("set max: %v", err)
	}
	for _, bad := range []int{0, -1, MaxAutoContinueMax + 1} {
		if err := UpdateAutoContinueMax(bad); err == nil {
			t.Fatalf("UpdateAutoContinueMax(%d) must be rejected", bad)
		}
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !GetAutoContinue() || GetAutoContinueMax() != 7 {
		t.Fatalf("persisted settings = %v/%d, want true/7", GetAutoContinue(), GetAutoContinueMax())
	}

	cfgLock.Lock()
	cfg.AutoContinueMax = 99
	cfgLock.Unlock()
	if got := GetAutoContinueMax(); got != MaxAutoContinueMax {
		t.Fatalf("an out-of-range stored value reads as %d, want the bound %d", got, MaxAutoContinueMax)
	}
}

package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestAccountRPMLimitDefaultAndRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if got := GetAccountRPMLimit(); got != 0 {
		t.Fatalf("default limit = %d, want 0 (off)", got)
	}
	for _, bad := range []int{-1, MaxAccountRPMLimit + 1} {
		if err := UpdateAccountRPMLimit(bad); !errors.Is(err, ErrAccountRPMLimitRange) {
			t.Fatalf("UpdateAccountRPMLimit(%d) = %v, want ErrAccountRPMLimitRange", bad, err)
		}
	}
	if got := GetAccountRPMLimit(); got != 0 {
		t.Fatalf("a rejected update changed the limit to %d", got)
	}
	if err := UpdateAccountRPMLimit(30); err != nil {
		t.Fatalf("set limit: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if got := GetAccountRPMLimit(); got != 30 {
		t.Fatalf("persisted limit = %d, want 30", got)
	}
	if err := UpdateAccountRPMLimit(0); err != nil {
		t.Fatalf("turn off: %v", err)
	}
	if got := GetAccountRPMLimit(); got != 0 {
		t.Fatalf("limit after turning off = %d, want 0", got)
	}

	cfgLock.Lock()
	cfg.AccountRPMLimit = MaxAccountRPMLimit + 5
	cfgLock.Unlock()
	if got := GetAccountRPMLimit(); got != 0 {
		t.Fatalf("an out-of-range stored value reads as %d, want 0 (off)", got)
	}
}

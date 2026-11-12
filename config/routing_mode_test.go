package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestRoutingModeDefaultsToWeighted(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if got := GetRoutingMode(); got != RoutingModeWeighted {
		t.Fatalf("fresh config routing mode = %q, want weighted", got)
	}
	// A hand-edited config with an unknown mode still routes, as weighted.
	cfgLock.Lock()
	cfg.RoutingMode = "fastest"
	cfgLock.Unlock()
	if got := GetRoutingMode(); got != RoutingModeWeighted {
		t.Fatalf("unknown stored mode reads as %q, want weighted", got)
	}
}

func TestUpdateRoutingModeRejectsUnknown(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateRoutingMode(RoutingModePriority); err != nil {
		t.Fatalf("set priority: %v", err)
	}
	for _, bad := range []string{"", "Priority", " priority", "round-robin"} {
		if err := UpdateRoutingMode(bad); !errors.Is(err, ErrInvalidRoutingMode) {
			t.Fatalf("UpdateRoutingMode(%q) error = %v, want ErrInvalidRoutingMode", bad, err)
		}
	}
	if got := GetRoutingMode(); got != RoutingModePriority {
		t.Fatalf("a rejected update changed the mode to %q", got)
	}
}

func TestRoutingModePersistsAcrossLoad(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateRoutingMode(RoutingModePriority); err != nil {
		t.Fatalf("set priority: %v", err)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := GetRoutingMode(); got != RoutingModePriority {
		t.Fatalf("routing mode after reload = %q, want priority", got)
	}
	if err := UpdateRoutingMode(RoutingModeWeighted); err != nil {
		t.Fatalf("set weighted: %v", err)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := GetRoutingMode(); got != RoutingModeWeighted {
		t.Fatalf("routing mode after reload = %q, want weighted", got)
	}
}

func TestAccountPriorityPersists(t *testing.T) {
	for _, credentials := range []bool{false, true} {
		name := "config accounts"
		if credentials {
			name = "credentials store"
		}
		t.Run(name, func(t *testing.T) {
			if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatalf("init config: %v", err)
			}
			if credentials {
				if err := ReplaceCredentials(true, nil); err != nil {
					t.Fatalf("switch to the credentials store: %v", err)
				}
			}
			if err := AddAccount(Account{ID: "a", Enabled: true, Priority: 3}); err != nil {
				t.Fatalf("add account: %v", err)
			}
			acc := GetAccounts()[0]
			acc.Priority = 7
			if err := UpdateAccount("a", acc); err != nil {
				t.Fatalf("update account: %v", err)
			}
			if err := Load(); err != nil {
				t.Fatalf("reload config: %v", err)
			}
			if err := LoadCredentials(); err != nil {
				t.Fatalf("reload credentials: %v", err)
			}
			got := GetAccounts()
			if len(got) != 1 || got[0].Priority != 7 {
				t.Fatalf("accounts after reload = %+v, want priority 7", got)
			}
		})
	}
	if !ValidAccountPriority(0) || !ValidAccountPriority(MaxAccountPriority) ||
		ValidAccountPriority(-1) || ValidAccountPriority(MaxAccountPriority+1) {
		t.Fatal("ValidAccountPriority bounds are not 0..999")
	}
}

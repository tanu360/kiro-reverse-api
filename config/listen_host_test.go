package config

import (
	"path/filepath"
	"testing"
)

func TestHostDefaultsToLoopback(t *testing.T) {
	t.Setenv("LISTEN_HOST", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if got := GetHost(); got != DefaultHost {
		t.Fatalf("fresh install listens on %q, want %q", got, DefaultHost)
	}

	// Older versions stored 0.0.0.0 for every install; it reads as the new default.
	cfgLock.Lock()
	cfg.Host = legacyDefaultHost
	cfgLock.Unlock()
	if got := GetHost(); got != DefaultHost {
		t.Fatalf("stored legacy host gives %q, want %q", got, DefaultHost)
	}

	cfgLock.Lock()
	cfg.Host = "192.168.1.20"
	cfgLock.Unlock()
	if got := GetHost(); got != "192.168.1.20" {
		t.Fatalf("stored host gives %q", got)
	}
}

func TestListenHostEnvironmentWins(t *testing.T) {
	t.Setenv("LISTEN_HOST", " 0.0.0.0 ")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if got := GetHost(); got != "0.0.0.0" {
		t.Fatalf("LISTEN_HOST gives %q, want 0.0.0.0", got)
	}
}

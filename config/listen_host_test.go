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

func TestPortEnvironmentWins(t *testing.T) {
	t.Setenv("PORT", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if got := GetPort(); got != 8080 {
		t.Fatalf("fresh install listens on port %d, want 8080", got)
	}
	if _, ignored := IgnoredPortEnv(); ignored {
		t.Fatal("an unset PORT reads as ignored")
	}
	t.Setenv("PORT", " 19490 ")
	if got := GetPort(); got != 19490 {
		t.Fatalf("PORT gives %d, want 19490", got)
	}
	if _, ignored := IgnoredPortEnv(); ignored {
		t.Fatal("PORT=19490 reads as ignored")
	}
	for _, bad := range []string{"0", "65536", "80800", "http", "-1"} {
		t.Setenv("PORT", bad)
		if got := GetPort(); got != 8080 {
			t.Fatalf("PORT=%q gives %d, want the stored 8080", bad, got)
		}
		//! Startup warns about it: a typo must not bind the stored port silently.
		if raw, ignored := IgnoredPortEnv(); !ignored || raw != bad {
			t.Fatalf("PORT=%q: IgnoredPortEnv = %q, %v", bad, raw, ignored)
		}
	}
}

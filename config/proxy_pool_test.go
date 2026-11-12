package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestProxyPoolSettingsDefaultsAndRoundTrip(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "admin-password")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if GetProxyPoolMode() != ProxyPoolModeOff || GetProxyDirectFallback() || GetProxyPoolCheckIntervalMin() != 10 || len(GetProxyPool()) != 0 {
		t.Fatalf("defaults: mode %q fallback %v interval %d pool %d",
			GetProxyPoolMode(), GetProxyDirectFallback(), GetProxyPoolCheckIntervalMin(), len(GetProxyPool()))
	}

	pool := []PoolProxy{{ID: "px_1", Label: "Tokyo", URL: "socks5://10.0.0.1:1080", Username: "u", Password: "p", CreatedAt: 1}}
	if err := SetProxyPool(pool); err != nil {
		t.Fatal(err)
	}
	on, fallback, interval := ProxyPoolModeOn, true, 0
	if err := UpdateProxyPoolSettings(&on, &fallback, &interval); err != nil {
		t.Fatal(err)
	}
	if err := SaveProxyPoolState(`{"assign":{"a":"px_1"}}`); err != nil {
		t.Fatal(err)
	}

	// The copy a caller gets cannot change the stored pool.
	got := GetProxyPool()
	got[0].Password = "changed"
	if GetProxyPool()[0].Password != "p" {
		t.Fatal("GetProxyPool returned the stored slice")
	}

	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if p := GetProxyPool(); len(p) != 1 || p[0] != pool[0] {
		t.Fatalf("pool after reload: %+v", p)
	}
	if GetProxyPoolMode() != ProxyPoolModeOn || !GetProxyDirectFallback() || GetProxyPoolCheckIntervalMin() != 0 {
		t.Fatal("settings did not survive a reload")
	}
	if raw, err := LoadProxyPoolState(); err != nil || raw != `{"assign":{"a":"px_1"}}` {
		t.Fatalf("state: %q %v", raw, err)
	}

	bad, tooLong := "maybe", 1441
	if err := UpdateProxyPoolSettings(&bad, nil, nil); !errors.Is(err, ErrProxyPoolMode) {
		t.Fatalf("bad mode: %v", err)
	}
	if err := UpdateProxyPoolSettings(nil, nil, &tooLong); !errors.Is(err, ErrProxyPoolCheckInterval) {
		t.Fatalf("bad interval: %v", err)
	}
	// A partial update leaves the other settings alone.
	off := ProxyPoolModeOff
	if err := UpdateProxyPoolSettings(&off, nil, nil); err != nil {
		t.Fatal(err)
	}
	if GetProxyPoolMode() != ProxyPoolModeOff || !GetProxyDirectFallback() || GetProxyPoolCheckIntervalMin() != 0 {
		t.Fatal("a mode-only update changed the other settings")
	}
}

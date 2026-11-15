package config

import "testing"

func TestNewerKiroVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.4.178", "1.4.154", true},
		{"1.4.154", "1.4.178", false},
		{"1.4.178", "1.4.178", false},
		{"1.10.0", "1.9.99", true},
		{"2.0", "1.99.99", true},
		{"1.4.178.1", "1.4.178", true},
		{"1.4", "1.4.0", false},
		{"", "1.4.178", false},
		{"1.4.x", "1.4.178", false},
		{"01.4.178", "1.4.154", false},
		{"1.4.178-beta", "1.4.154", false},
		{"1", "0.9", false},
		{"1.4.178", "garbage", true},
	}
	for _, c := range cases {
		if got := newerKiroVersion(c.a, c.b); got != c.want {
			t.Errorf("newerKiroVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestTheFetchedKiroVersionIsAdvertisedOnlyWhenNewer(t *testing.T) {
	t.Cleanup(func() { latestKiroVersion.Store(nil) })
	if got := GetKiroClientConfig().KiroVersion; got != defaultKiroVersion {
		t.Fatalf("before a fetch = %q, want the built-in %q", got, defaultKiroVersion)
	}
	for _, v := range []string{"", "1.4.x", "0.9.2", defaultKiroVersion} {
		if SetLatestKiroVersion(v) {
			t.Errorf("SetLatestKiroVersion(%q) took it", v)
		}
	}
	if !SetLatestKiroVersion("99.0.1") {
		t.Fatal("a newer release was refused")
	}
	if SetLatestKiroVersion("99.0.0") || SetLatestKiroVersion("99.0.1") {
		t.Error("an older or the same release replaced the newer one")
	}
	if got := GetKiroClientConfig().KiroVersion; got != "99.0.1" {
		t.Errorf("after a fetch = %q, want 99.0.1", got)
	}

	// config.kiroVersion still wins.
	cfgLock.Lock()
	saved := cfg
	cfg = &Config{KiroVersion: "1.0.0"}
	cfgLock.Unlock()
	t.Cleanup(func() {
		cfgLock.Lock()
		cfg = saved
		cfgLock.Unlock()
	})
	if got := GetKiroClientConfig().KiroVersion; got != "1.0.0" {
		t.Errorf("with config.kiroVersion = %q, want 1.0.0", got)
	}
}

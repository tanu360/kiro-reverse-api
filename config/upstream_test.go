package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func initUpstreamTestConfig(t *testing.T) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
}

func TestUpstreamConfigDefaults(t *testing.T) {
	initUpstreamTestConfig(t)
	want := UpstreamConfig{APIDomain: APIDomainAmazonaws}
	if got := GetUpstreamConfig(); got != want {
		t.Fatalf("defaults = %+v, want %+v", got, want)
	}
	if GetAPIDomain() != APIDomainAmazonaws || GetAPIRegionOverride() != "" || GetAuthRegionOverride() != "" {
		t.Fatalf("getters must return the defaults")
	}
}

func TestUpdateUpstreamConfigValidates(t *testing.T) {
	initUpstreamTestConfig(t)

	for name, tc := range map[string]struct {
		in   UpstreamConfig
		want error
	}{
		"unknown domain":             {UpstreamConfig{APIDomain: "evil.example"}, ErrInvalidAPIDomain},
		"unserved api region":        {UpstreamConfig{APIRegion: "us-west-2"}, ErrInvalidRegion},
		"host in api region":         {UpstreamConfig{APIRegion: "eu-central-1.evil.example"}, ErrInvalidRegion},
		"path in auth region":        {UpstreamConfig{AuthRegion: "evil.com/x"}, ErrInvalidRegion},
		"host suffix in auth region": {UpstreamConfig{AuthRegion: "us-east-1.evil.example"}, ErrInvalidRegion},
	} {
		if err := UpdateUpstreamConfig(tc.in); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
	if got := GetUpstreamConfig(); got != (UpstreamConfig{APIDomain: APIDomainAmazonaws}) {
		t.Fatalf("a rejected update must change nothing, got %+v", got)
	}

	//! Case and spaces are normalised; Identity Center can live outside Kiro's data-plane regions.
	if err := UpdateUpstreamConfig(UpstreamConfig{APIDomain: " KIRO ", APIRegion: "EU-CENTRAL-1", AuthRegion: " ap-southeast-2 "}); err != nil {
		t.Fatalf("valid update: %v", err)
	}
	want := UpstreamConfig{APIDomain: APIDomainKiro, APIRegion: "eu-central-1", AuthRegion: "ap-southeast-2"}
	if got := GetUpstreamConfig(); got != want {
		t.Fatalf("after update = %+v, want %+v", got, want)
	}

	if err := UpdateUpstreamConfig(UpstreamConfig{}); err != nil {
		t.Fatalf("clearing update: %v", err)
	}
	if got := GetUpstreamConfig(); got != (UpstreamConfig{APIDomain: APIDomainAmazonaws}) {
		t.Fatalf("empty values must clear every override, got %+v", got)
	}
}

func TestUpstreamConfigPersistsAcrossLoad(t *testing.T) {
	initUpstreamTestConfig(t)
	want := UpstreamConfig{APIDomain: APIDomainKiro, APIRegion: "us-east-1", AuthRegion: "eu-west-1"}
	if err := UpdateUpstreamConfig(want); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := GetUpstreamConfig(); got != want {
		t.Fatalf("after reload = %+v, want %+v", got, want)
	}

	//! The default domain is stored as "", so a config saved without the feature reads the same.
	if err := UpdateUpstreamConfig(UpstreamConfig{APIDomain: APIDomainAmazonaws}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if stored := Get().APIDomain; stored != "" {
		t.Fatalf("default domain stored as %q, want empty", stored)
	}
}

func TestUpstreamGettersIgnoreTamperedValues(t *testing.T) {
	initUpstreamTestConfig(t)
	cfgLock.Lock()
	cfg.APIDomain = "evil.example"
	cfg.APIRegion = "us-west-2"
	cfg.AuthRegion = "evil.com/x"
	cfgLock.Unlock()

	if got := GetUpstreamConfig(); got != (UpstreamConfig{APIDomain: APIDomainAmazonaws}) {
		t.Fatalf("tampered values must read as defaults, got %+v", got)
	}
	if GetAPIDomain() != APIDomainAmazonaws || GetAPIRegionOverride() != "" || GetAuthRegionOverride() != "" {
		t.Fatalf("getters must ignore tampered values")
	}
}

func TestUpstreamGettersNilConfig(t *testing.T) {
	cfgLock.Lock()
	saved := cfg
	cfg = nil
	cfgLock.Unlock()
	t.Cleanup(func() {
		cfgLock.Lock()
		cfg = saved
		cfgLock.Unlock()
	})

	if got := GetUpstreamConfig(); got != (UpstreamConfig{APIDomain: APIDomainAmazonaws}) {
		t.Fatalf("nil config = %+v, want defaults", got)
	}
	if GetAPIDomain() != APIDomainAmazonaws || GetAPIRegionOverride() != "" || GetAuthRegionOverride() != "" {
		t.Fatalf("getters must not panic and must return defaults without a config")
	}
	if err := UpdateUpstreamConfig(UpstreamConfig{APIDomain: APIDomainKiro}); err == nil {
		t.Fatalf("an update without a config must fail")
	}
}

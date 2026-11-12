package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCountTokensSettingsDefaults(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	got := GetCountTokensSettings()
	if got.APIURL != "" || got.APIKey != "" || got.AuthType != CountTokensAuthXAPIKey {
		t.Fatalf("defaults = %+v, want no URL, no key and x-api-key", got)
	}

	cfgLock.Lock()
	cfg.CountTokensAuthType = "basic"
	cfgLock.Unlock()
	if got := GetCountTokensSettings().AuthType; got != CountTokensAuthXAPIKey {
		t.Fatalf("an unknown stored auth type reads as %q, want x-api-key", got)
	}
}

func TestCountTokensSettingsPersistAndKeepKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	key := "  sk-ant-test-0123456789  "
	if err := UpdateCountTokensSettings(" https://count.example/v1/messages/count_tokens ", CountTokensAuthBearer, &key, false); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	want := CountTokensSettings{
		APIURL:   "https://count.example/v1/messages/count_tokens",
		APIKey:   "sk-ant-test-0123456789",
		AuthType: CountTokensAuthBearer,
	}
	if got := GetCountTokensSettings(); got != want {
		t.Fatalf("persisted = %+v, want %+v", got, want)
	}

	// A blank or missing key keeps the saved one while the origin stays: a new path, the
	// default port spelled out, the host in capitals.
	blank := ""
	if err := UpdateCountTokensSettings("https://COUNT.example:443/v2/count", CountTokensAuthXAPIKey, &blank, false); err != nil {
		t.Fatalf("save with blank key: %v", err)
	}
	if err := UpdateCountTokensSettings("https://count.example/v2/count?beta=true", "", nil, false); err != nil {
		t.Fatalf("save with no key: %v", err)
	}
	got := GetCountTokensSettings()
	if got.APIKey != want.APIKey || got.APIURL != "https://count.example/v2/count?beta=true" || got.AuthType != CountTokensAuthXAPIKey {
		t.Fatalf("after edits = %+v, want the saved key kept", got)
	}

	// Another scheme, host or port without a new key drops the saved key: it was given for
	// the old host only.
	for _, moved := range []string{
		"http://count.example/v2/count",
		"https://counter.example/v2/count",
		"https://count.example:8443/v2/count",
	} {
		reset := want.APIKey
		if err := UpdateCountTokensSettings("https://count.example/v2/count", CountTokensAuthXAPIKey, &reset, false); err != nil {
			t.Fatalf("reset: %v", err)
		}
		if err := UpdateCountTokensSettings(moved, CountTokensAuthXAPIKey, &blank, false); err != nil {
			t.Fatalf("move to %s: %v", moved, err)
		}
		if got := GetCountTokensSettings(); got.APIKey != "" || got.APIURL != moved {
			t.Fatalf("after a move to %s = %+v, want the key dropped", moved, got)
		}
	}
	// A new key given with the new host is saved.
	moved := "sk-moved-key-0123456789"
	if err := UpdateCountTokensSettings("http://127.0.0.1:9000/count", CountTokensAuthXAPIKey, &moved, false); err != nil {
		t.Fatalf("move with a key: %v", err)
	}
	got = GetCountTokensSettings()
	if got.APIKey != moved || got.APIURL != "http://127.0.0.1:9000/count" {
		t.Fatalf("after a move with a key = %+v", got)
	}

	// clearKey drops it; a new key in the same call replaces it.
	if err := UpdateCountTokensSettings(got.APIURL, got.AuthType, nil, true); err != nil {
		t.Fatalf("clear key: %v", err)
	}
	if got := GetCountTokensSettings().APIKey; got != "" {
		t.Fatalf("key after clear = %q, want empty", got)
	}
	next := "sk-next-key-abcdef"
	if err := UpdateCountTokensSettings(got.APIURL, got.AuthType, &next, true); err != nil {
		t.Fatalf("replace key: %v", err)
	}
	if got := GetCountTokensSettings().APIKey; got != next {
		t.Fatalf("key after replace = %q, want %q", got, next)
	}

	for _, bad := range []struct {
		url, auth, key string
	}{
		{"ftp://count.example", CountTokensAuthXAPIKey, ""},
		{"https://count.example", "basic", ""},
		{"https://count.example", CountTokensAuthXAPIKey, "two words"},
		{"https://count.example", CountTokensAuthXAPIKey, strings.Repeat("k", MaxCountTokensKeyLen+1)},
	} {
		key := bad.key
		if err := UpdateCountTokensSettings(bad.url, bad.auth, &key, false); err == nil {
			t.Fatalf("UpdateCountTokensSettings(%q, %q, %q) must be rejected", bad.url, bad.auth, bad.key)
		}
	}
	if got := GetCountTokensSettings().APIKey; got != next {
		t.Fatalf("a rejected update changed the key to %q", got)
	}
}

func TestCountTokensSettingsClearOnEmptyURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	key := "sk-ant-test-0123456789"
	if err := UpdateCountTokensSettings("https://count.example/count", CountTokensAuthBearer, &key, false); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := UpdateCountTokensSettings("   ", CountTokensAuthBearer, &key, false); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload config: %v", err)
	}
	cfgLock.RLock()
	stored := [3]string{cfg.CountTokensApiURL, cfg.CountTokensApiKey, cfg.CountTokensAuthType}
	cfgLock.RUnlock()
	if stored != [3]string{} {
		t.Fatalf("stored after clear = %q, want all empty", stored)
	}
}

func TestValidateCountTokensURL(t *testing.T) {
	for _, ok := range []string{
		"http://127.0.0.1:8787/v1/messages/count_tokens",
		"https://api.anthropic.com/v1/messages/count_tokens",
		"HTTPS://Count.Example",
		"http://[::1]:9000/count?beta=true",
	} {
		if err := ValidateCountTokensURL(ok); err != nil {
			t.Errorf("ValidateCountTokensURL(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{
		"",
		"count.example/v1",
		"ftp://count.example",
		"socks5://127.0.0.1:1080",
		"https://",
		"https:///path",
		"https://user:secret@count.example",
		"https://count.example/a b",
		"https://count.example/\n",
		"https://count.example/" + strings.Repeat("a", MaxCountTokensURLLen),
	} {
		if err := ValidateCountTokensURL(bad); err == nil {
			t.Errorf("ValidateCountTokensURL(%q) = nil, want an error", bad)
		}
	}
}

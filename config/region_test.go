package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestNormalizeAWSRegion(t *testing.T) {
	for input, want := range map[string]string{
		"":               "us-east-1",
		"  ":             "us-east-1",
		" EU-Central-1 ": "eu-central-1",
		"ap-southeast-2": "ap-southeast-2",
		"us-gov-west-1":  "us-gov-west-1",
		"cn-northwest-1": "cn-northwest-1",
	} {
		got, err := NormalizeAWSRegion(input)
		if err != nil || got != want {
			t.Errorf("NormalizeAWSRegion(%q) = (%q, %v), want %q", input, got, err, want)
		}
	}
	for _, input := range []string{
		"@evil.example/x#",
		"evil.example",
		"us-east-1.evil.example",
		"us-east-1/../x",
		"us-east-1#",
		"us east 1",
		"useast1",
		"us-east-1:443",
	} {
		if got, err := NormalizeAWSRegion(input); !errors.Is(err, ErrInvalidRegion) {
			t.Errorf("NormalizeAWSRegion(%q) = (%q, %v), want ErrInvalidRegion", input, got, err)
		}
	}
}

func TestAddAccountRestrictsNewAPIKeyAccountsToKiroRegions(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	for _, account := range []Account{
		{ID: "sydney", KiroApiKey: "ksk_sydney", AuthMethod: AuthMethodAPIKey, Region: "ap-southeast-2"},
		{ID: "sydney-pipe", KiroApiKey: "ksk_sydney_pipe|ap-southeast-2", AuthMethod: AuthMethodAPIKey},
	} {
		if err := AddAccount(account); !errors.Is(err, ErrUnsupportedKiroAPIKeyRegion) {
			t.Fatalf("AddAccount(%s) = %v, want ErrUnsupportedKiroAPIKeyRegion", account.ID, err)
		}
	}
	for _, account := range []Account{
		{ID: "virginia", KiroApiKey: "ksk_virginia", AuthMethod: AuthMethodAPIKey},
		{ID: "frankfurt", KiroApiKey: "ksk_frankfurt|eu-central-1", AuthMethod: AuthMethodAPIKey},
	} {
		if err := AddAccount(account); err != nil {
			t.Fatalf("AddAccount(%s): %v", account.ID, err)
		}
	}
	if n := len(GetAccounts()); n != 2 {
		t.Fatalf("expected only the two served-region keys to be stored, got %d", n)
	}
}

func TestPersistedAPIKeyAccountInUnservedRegionStillLoads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro.db")
	if err := Init(path); err != nil {
		t.Fatalf("init config: %v", err)
	}
	legacy := Account{ID: "legacy", KiroApiKey: "ksk_legacy", AuthMethod: AuthMethodAPIKey, Region: "ap-southeast-2", Enabled: true}
	if err := NormalizeAPIKeyAccount(&legacy); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if err := AddCredential(legacy); err != nil {
		t.Fatalf("seed legacy credential: %v", err)
	}
	if err := Init(path); err != nil {
		t.Fatalf("reload with a legacy API key region must not fail: %v", err)
	}
	accounts := GetAccounts()
	if len(accounts) != 1 || accounts[0].Region != "ap-southeast-2" || !accounts[0].Enabled {
		t.Fatalf("legacy account must survive unchanged, got %+v", accounts)
	}
}

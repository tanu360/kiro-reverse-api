package config

import (
	"path/filepath"
	"testing"
)

func TestApiKeyCRUDAndUsage(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	created, err := AddApiKey(ApiKeyEntry{Name: "alpha", Key: "sk-alpha", Enabled: true, TokenLimit: 100})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if _, err := AddApiKey(ApiKeyEntry{Name: "dup", Key: "sk-alpha", Enabled: true}); err == nil {
		t.Fatalf("expected duplicate key to fail")
	}
	if found := FindApiKeyByValue("sk-alpha"); found == nil || found.ID != created.ID {
		t.Fatalf("FindApiKeyByValue failed: %#v", found)
	}
	if err := RecordApiKeyUsage(created.ID, 40, 1.5); err != nil {
		t.Fatalf("record usage: %v", err)
	}
	got := GetApiKeyEntry(created.ID)
	if got == nil || got.TokensUsed != 40 || got.CreditsUsed != 1.5 || got.RequestsCount != 1 || got.LastUsedAt == 0 {
		t.Fatalf("unexpected usage: %#v", got)
	}

	if err := UpdateApiKey(created.ID, ApiKeyEntry{Name: "renamed", Key: "sk-renamed", Enabled: false, CreditLimit: 3}); err != nil {
		t.Fatalf("update key: %v", err)
	}
	got = GetApiKeyEntry(created.ID)
	if got == nil || got.Name != "renamed" || got.Key != "sk-renamed" || got.Enabled || got.CreditLimit != 3 {
		t.Fatalf("unexpected updated key: %#v", got)
	}

	if err := ResetApiKeyUsage(created.ID); err != nil {
		t.Fatalf("reset usage: %v", err)
	}
	got = GetApiKeyEntry(created.ID)
	if got == nil || got.TokensUsed != 0 || got.CreditsUsed != 0 || got.RequestsCount != 0 {
		t.Fatalf("usage was not reset: %#v", got)
	}
	if err := DeleteApiKey(created.ID); err != nil {
		t.Fatalf("delete key: %v", err)
	}
	if GetApiKeyEntry(created.ID) != nil {
		t.Fatalf("expected key to be deleted")
	}
}

func TestApiKeyValidationRejectsNegativeLimits(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	if _, err := AddApiKey(ApiKeyEntry{Name: "bad tokens", Key: "sk-token", Enabled: true, TokenLimit: -1}); err == nil {
		t.Fatalf("expected negative token limit to fail")
	}
	if _, err := AddApiKey(ApiKeyEntry{Name: "bad credits", Key: "sk-credit", Enabled: true, CreditLimit: -0.01}); err == nil {
		t.Fatalf("expected negative credit limit to fail")
	}

	created, err := AddApiKey(ApiKeyEntry{Name: "valid", Key: "sk-valid", Enabled: true, TokenLimit: 10, CreditLimit: 2})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if err := UpdateApiKey(created.ID, ApiKeyEntry{Name: "invalid", Key: "sk-valid", Enabled: true, TokenLimit: -5}); err == nil {
		t.Fatalf("expected negative token limit update to fail")
	}
	if err := UpdateApiKey(created.ID, ApiKeyEntry{Name: "invalid", Key: "sk-valid", Enabled: true, CreditLimit: -1}); err == nil {
		t.Fatalf("expected negative credit limit update to fail")
	}

	got := GetApiKeyEntry(created.ID)
	if got == nil || got.TokenLimit != 10 || got.CreditLimit != 2 || got.Name != "valid" {
		t.Fatalf("invalid update changed key: %#v", got)
	}
}

func TestApiKeyUpdateRejectsBlankKeyValue(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	created, err := AddApiKey(ApiKeyEntry{Name: "valid", Key: "sk-valid", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}

	if err := UpdateApiKey(created.ID, ApiKeyEntry{Name: "blank", Key: "   ", Enabled: true}); err == nil {
		t.Fatalf("expected blank key update to fail")
	}

	got := GetApiKeyEntry(created.ID)
	if got == nil || got.Key != "sk-valid" || got.Name != "valid" {
		t.Fatalf("blank key update changed key: %#v", got)
	}
}

func TestApiKeyUsageReservationGuardsTokenLimit(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	created, err := AddApiKey(ApiKeyEntry{Name: "limited", Key: "sk-limited", Enabled: true, TokenLimit: 10})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}

	if err := ReserveApiKeyUsage(created.ID, 7, 0); err != nil {
		t.Fatalf("reserve usage: %v", err)
	}
	if err := ReserveApiKeyUsage(created.ID, 4, 0); err == nil {
		t.Fatalf("expected reservation beyond token limit to fail")
	}
	got := GetApiKeyEntry(created.ID)
	if got == nil || got.TokensUsed != 7 || got.RequestsCount != 0 {
		t.Fatalf("unexpected usage after failed reservation: %#v", got)
	}
	if err := FinalizeApiKeyUsageReservation(created.ID, 7, 0, 6, 0.25); err != nil {
		t.Fatalf("finalize reservation: %v", err)
	}
	got = GetApiKeyEntry(created.ID)
	if got == nil || got.TokensUsed != 6 || got.CreditsUsed != 0.25 || got.RequestsCount != 1 || got.LastUsedAt == 0 {
		t.Fatalf("unexpected finalized usage: %#v", got)
	}
	if err := ReserveApiKeyUsage(created.ID, 5, 0); err == nil {
		t.Fatalf("expected projected token limit to fail")
	}
}

func TestApiKeyRequestReservationHoldsRemainingCredits(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	created, err := AddApiKey(ApiKeyEntry{Name: "credit", Key: "sk-credit", Enabled: true, CreditLimit: 2})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}

	reservedCredits, err := ReserveApiKeyRequestUsage(created.ID, 1)
	if err != nil {
		t.Fatalf("reserve request usage: %v", err)
	}
	if reservedCredits != 2 {
		t.Fatalf("expected all remaining credits to be reserved, got %v", reservedCredits)
	}
	if _, err := ReserveApiKeyRequestUsage(created.ID, 1); err == nil {
		t.Fatalf("expected concurrent credit reservation to fail")
	}
	if err := FinalizeApiKeyUsageReservation(created.ID, 1, reservedCredits, 1, 0.75); err != nil {
		t.Fatalf("finalize usage: %v", err)
	}
	got := GetApiKeyEntry(created.ID)
	if got == nil || got.CreditsUsed != 0.75 || got.RequestsCount != 1 || !got.Enabled {
		t.Fatalf("unexpected finalized credit usage: %#v", got)
	}
}

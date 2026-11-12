package config

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func initAccessTest(t *testing.T, accountIDs ...string) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	for _, id := range accountIDs {
		if err := AddAccount(Account{ID: id, Email: id + "@example.com", Enabled: true}); err != nil {
			t.Fatalf("add account %s: %v", id, err)
		}
	}
}

// finishCall reserves a call and finalizes it, as a request that finished OK does.
func finishCall(t *testing.T, id string) {
	t.Helper()
	credits, err := ReserveApiKeyRequestUsage(id, 1)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := FinalizeApiKeyUsageReservation(id, 1, credits, 1, 0); err != nil {
		t.Fatalf("finalize: %v", err)
	}
}

func TestApiKeyCallLimitCountsSuccessfulCalls(t *testing.T) {
	initAccessTest(t)
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-calls", Enabled: true, CallLimit: 2})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}

	finishCall(t, created.ID)
	finishCall(t, created.ID)
	got := GetApiKeyEntry(created.ID)
	if got.SuccessfulCalls != 2 || got.RequestsCount != 2 {
		t.Fatalf("successfulCalls=%d requestsCount=%d, want 2 and 2", got.SuccessfulCalls, got.RequestsCount)
	}

	_, err = ReserveApiKeyRequestUsage(created.ID, 1)
	if !errors.Is(err, ErrApiKeyCallLimitExceeded) {
		t.Fatalf("third reserve err = %v, want the call limit", err)
	}
	if want := "API key call limit reached: 2 of 2 successful calls used"; err.Error() != want {
		t.Fatalf("message = %q, want %q", err.Error(), want)
	}
	if err := ApiKeyCallLimitError(*got); err == nil || err.Error() != "API key call limit reached: 2 of 2 successful calls used" {
		t.Fatalf("ApiKeyCallLimitError = %v", err)
	}
	// A call limit refuses calls; unlike a token or credit limit it does not disable the key.
	if !GetApiKeyEntry(created.ID).Enabled {
		t.Fatal("the call limit disabled the key")
	}

	// Raising the limit gives the key calls again at once.
	if err := UpdateApiKey(created.ID, ApiKeyEntry{Enabled: true, CallLimit: 3}); err != nil {
		t.Fatalf("raise limit: %v", err)
	}
	finishCall(t, created.ID)

	// 0 is unlimited, like the token and credit limits.
	if err := UpdateApiKey(created.ID, ApiKeyEntry{Enabled: true}); err != nil {
		t.Fatalf("clear limit: %v", err)
	}
	if ApiKeyCallLimitError(*GetApiKeyEntry(created.ID)) != nil {
		t.Fatal("a key without a call limit reports the limit")
	}
	finishCall(t, created.ID)
}

// Calls in progress hold their slot, so N concurrent requests at the limit
// cannot all start; a released slot is free again.
func TestApiKeyCallLimitReservesInFlightCalls(t *testing.T) {
	initAccessTest(t)
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-inflight", Enabled: true, CallLimit: 3})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	finishCall(t, created.ID)

	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := ReserveApiKeyRequestUsage(created.ID, 1); err == nil {
				mu.Lock()
				granted++
				mu.Unlock()
			} else if !errors.Is(err, ErrApiKeyCallLimitExceeded) {
				t.Errorf("reserve err = %v", err)
			}
		}()
	}
	wg.Wait()
	if granted != 2 {
		t.Fatalf("granted %d concurrent calls, want 2 (limit 3, 1 used)", granted)
	}

	_, err = ReserveApiKeyRequestUsage(created.ID, 1)
	if want := "API key call limit reached: 1 of 3 successful calls used, 2 more in progress"; err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}

	if err := ReleaseApiKeyUsageReservation(created.ID, 1, 0); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := ReserveApiKeyRequestUsage(created.ID, 1); err != nil {
		t.Fatalf("a released slot is not free again: %v", err)
	}
}

// A failed request releases its reservation: no successful call is counted.
func TestApiKeyReleaseDoesNotCountSuccessfulCall(t *testing.T) {
	initAccessTest(t)
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-release", Enabled: true, CallLimit: 1})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	for i := 0; i < 3; i++ {
		credits, err := ReserveApiKeyRequestUsage(created.ID, 5)
		if err != nil {
			t.Fatalf("reserve %d: %v", i, err)
		}
		if err := ReleaseApiKeyUsageReservation(created.ID, 5, credits); err != nil {
			t.Fatalf("release %d: %v", i, err)
		}
	}
	got := GetApiKeyEntry(created.ID)
	if got.SuccessfulCalls != 0 || got.RequestsCount != 0 || got.TokensUsed != 0 {
		t.Fatalf("released calls were counted: %#v", got)
	}
}

func TestApiKeyResetUsageClearsSuccessfulCalls(t *testing.T) {
	initAccessTest(t)
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-reset", Enabled: true, CallLimit: 1})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	finishCall(t, created.ID)
	if _, err := ReserveApiKeyRequestUsage(created.ID, 1); !errors.Is(err, ErrApiKeyCallLimitExceeded) {
		t.Fatalf("err = %v, want the call limit", err)
	}
	if err := ResetApiKeyUsage(created.ID); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if got := GetApiKeyEntry(created.ID); got.SuccessfulCalls != 0 {
		t.Fatalf("successfulCalls = %d after reset", got.SuccessfulCalls)
	}
	finishCall(t, created.ID)
}

func TestApiKeyRejectsNegativeCallLimit(t *testing.T) {
	initAccessTest(t)
	if _, err := AddApiKey(ApiKeyEntry{Key: "sk-negative", Enabled: true, CallLimit: -1}); !errors.Is(err, ErrCallLimitNegative) {
		t.Fatalf("add err = %v, want ErrCallLimitNegative", err)
	}
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-negative", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if err := UpdateApiKey(created.ID, ApiKeyEntry{Enabled: true, CallLimit: -5}); !errors.Is(err, ErrCallLimitNegative) {
		t.Fatalf("update err = %v, want ErrCallLimitNegative", err)
	}
}

func TestApiKeyAccountIDsNormalizeAndValidate(t *testing.T) {
	initAccessTest(t, "acct-a", "acct-b")

	created, err := AddApiKey(ApiKeyEntry{Key: "sk-bound", Enabled: true, AccountIDs: []string{" acct-b ", "", "acct-a", "acct-b"}})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if want := []string{"acct-b", "acct-a"}; !reflect.DeepEqual(created.AccountIDs, want) {
		t.Fatalf("accountIds = %v, want %v", created.AccountIDs, want)
	}

	if _, err := AddApiKey(ApiKeyEntry{Key: "sk-ghost", Enabled: true, AccountIDs: []string{"acct-ghost"}}); !errors.Is(err, ErrApiKeyUnknownAccount) {
		t.Fatalf("unknown account err = %v", err)
	}

	// Blanks only is no binding at all.
	open, err := AddApiKey(ApiKeyEntry{Key: "sk-open", Enabled: true, AccountIDs: []string{" ", ""}})
	if err != nil || open.AccountIDs != nil {
		t.Fatalf("blank ids: entry=%v err=%v, want nil ids", open.AccountIDs, err)
	}

	// A deleted account stays on the key: it never matches, and it never
	// blocks an unrelated edit or widens the key to every account.
	if err := DeleteAccount("acct-a"); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	stored := GetApiKeyEntry(created.ID)
	if want := []string{"acct-b", "acct-a"}; !reflect.DeepEqual(stored.AccountIDs, want) {
		t.Fatalf("after account delete accountIds = %v, want %v", stored.AccountIDs, want)
	}
	stored.Name = "renamed"
	if err := UpdateApiKey(created.ID, *stored); err != nil {
		t.Fatalf("edit with a stale id: %v", err)
	}
	stored.AccountIDs = []string{"acct-b", "acct-new"}
	if err := UpdateApiKey(created.ID, *stored); !errors.Is(err, ErrApiKeyUnknownAccount) {
		t.Fatalf("new unknown id err = %v", err)
	}

	// An empty list binds the key to every account again.
	stored.AccountIDs = []string{}
	if err := UpdateApiKey(created.ID, *stored); err != nil {
		t.Fatalf("clear binding: %v", err)
	}
	if got := GetApiKeyEntry(created.ID).AccountIDs; got != nil {
		t.Fatalf("cleared accountIds = %v, want nil", got)
	}
}

func TestRegenerateApiKeyKeepsIdentityAndUsage(t *testing.T) {
	initAccessTest(t, "acct-a")
	created, err := AddApiKey(ApiKeyEntry{
		Name: "laptop", Key: "sk-old-value", Enabled: false,
		TokenLimit: 100, CreditLimit: 2, CallLimit: 9, AccountIDs: []string{"acct-a"},
	})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if err := RecordApiKeyUsage(created.ID, 10, 0.5); err != nil {
		t.Fatalf("record usage: %v", err)
	}
	before := GetApiKeyEntry(created.ID)

	regenerated, err := RegenerateApiKey(created.ID)
	if err != nil {
		t.Fatalf("regenerate: %v", err)
	}
	if regenerated.Key == "sk-old-value" || !strings.HasPrefix(regenerated.Key, "sk-") || len(regenerated.Key) != 67 {
		t.Fatalf("new key = %q, want a fresh sk-<64 hex>", regenerated.Key)
	}
	if FindApiKeyByValue("sk-old-value") != nil {
		t.Fatal("the old value still finds the key")
	}
	after := FindApiKeyByValue(regenerated.Key)
	if after == nil {
		t.Fatal("the new value does not find the key")
	}
	after.Key = before.Key
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("regenerate changed more than the value:\nbefore %#v\nafter  %#v", before, after)
	}

	if _, err := RegenerateApiKey("missing"); !errors.Is(err, ErrApiKeyNotFound) {
		t.Fatalf("missing key err = %v", err)
	}
}

func TestDeleteApiKeyDropsPendingCalls(t *testing.T) {
	initAccessTest(t)
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-pending", Enabled: true, CallLimit: 5})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	if _, err := ReserveApiKeyRequestUsage(created.ID, 1); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := DeleteApiKey(created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	cfgLock.RLock()
	_, left := apiKeyPendingCalls[created.ID]
	cfgLock.RUnlock()
	if left {
		t.Fatal("a deleted key keeps its pending calls")
	}
}

// An install that keeps its accounts in the credentials store (as after
// restoring a credentials backup) has an empty cfg.Accounts; binding a key must
// check ids against the credentials store then.
func TestApiKeyAccountIDsUseCredentialsStore(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := ReplaceCredentials(true, []Account{{ID: "cred-1", Email: "a@example.com", Enabled: true}}); err != nil {
		t.Fatalf("ReplaceCredentials: %v", err)
	}
	created, err := AddApiKey(ApiKeyEntry{Key: "sk-cred-bound", Enabled: true, AccountIDs: []string{"cred-1"}})
	if err != nil {
		t.Fatalf("bind to a credentials-store account: %v", err)
	}
	if !reflect.DeepEqual(created.AccountIDs, []string{"cred-1"}) {
		t.Fatalf("AccountIDs = %v, want [cred-1]", created.AccountIDs)
	}
	patch := *GetApiKeyEntry(created.ID)
	patch.AccountIDs = []string{"cred-1", "missing"}
	if err := UpdateApiKey(created.ID, patch); !errors.Is(err, ErrApiKeyUnknownAccount) {
		t.Fatalf("update with an unknown id: err = %v, want ErrApiKeyUnknownAccount", err)
	}
	patch.AccountIDs = []string{"cred-1"}
	patch.Name = "renamed"
	if err := UpdateApiKey(created.ID, patch); err != nil {
		t.Fatalf("update on a credentials-store install: %v", err)
	}
}

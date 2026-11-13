package config

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func initDedupStore(t *testing.T, credentialsStore bool) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if credentialsStore {
		if err := ReplaceCredentials(true, nil); err != nil {
			t.Fatalf("switch to the credentials store: %v", err)
		}
	}
}

func forEachStore(t *testing.T, run func(t *testing.T)) {
	for _, store := range []struct {
		name        string
		credentials bool
	}{{"config", false}, {"credentials", true}} {
		t.Run(store.name, func(t *testing.T) {
			initDedupStore(t, store.credentials)
			run(t)
		})
	}
}

func groupIDs(groups []DuplicateGroup) [][]string {
	out := make([][]string, 0, len(groups))
	for _, g := range groups {
		out = append(out, g.IDs)
	}
	return out
}

func TestDuplicateGroupsByRefreshToken(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", RefreshToken: "rt-1", AuthMethod: "social", Email: "a@example.com"},
		{ID: "b", RefreshToken: "rt-2", AuthMethod: "social"},
		{ID: "c", RefreshToken: " rt-1 ", AuthMethod: "idc", Email: "other@example.com"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "c"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(groups[0].Reasons, []string{DuplicateReasonRefreshToken}) {
		t.Fatalf("reasons = %v", groups[0].Reasons)
	}
}

func TestDuplicateGroupsByProviderUserID(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", Provider: "BuilderId", AuthMethod: "idc", UserId: "u-1", Email: "a@example.com"},
		{ID: "b", Provider: "builderid", AuthMethod: "idc", UserId: "u-1", Email: "renamed@example.com"},
		{ID: "c", Provider: "Google", AuthMethod: "social", UserId: "u-1"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "b"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(groups[0].Reasons, []string{DuplicateReasonUserID}) {
		t.Fatalf("reasons = %v", groups[0].Reasons)
	}
}

func TestDuplicateGroupsByEmailWhenUserIDMissing(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", Provider: "BuilderId", AuthMethod: "idc", Email: "Dev@Example.com", UserId: "u-1"},
		{ID: "b", Provider: "BuilderId", AuthMethod: "IDC", Email: "dev@example.com"},
		{ID: "c", Provider: "Github", AuthMethod: "social", Email: "dev@example.com"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "b"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(groups[0].Reasons, []string{DuplicateReasonEmail}) {
		t.Fatalf("reasons = %v", groups[0].Reasons)
	}
}

func TestDuplicateGroupsSkipDifferentUserIDOrProfile(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", AuthMethod: "idc", Email: "dev@example.com", UserId: "u-1"},
		{ID: "b", AuthMethod: "idc", Email: "dev@example.com", UserId: "u-2"},
		{ID: "c", AuthMethod: "idc", Email: "ops@example.com", ProfileArn: "arn:aws:codewhisperer:us-east-1:1:profile/A"},
		{ID: "d", AuthMethod: "idc", Email: "ops@example.com", ProfileArn: "arn:aws:codewhisperer:us-east-1:2:profile/B"},
		{ID: "e", AuthMethod: AuthMethodExternalIdp, Provider: "AzureAD", Email: "me@contoso.com", IssuerURL: "https://login.microsoftonline.com/t1/v2.0"},
		{ID: "f", AuthMethod: AuthMethodExternalIdp, Provider: "AzureAD", Email: "me@contoso.com", IssuerURL: "https://login.microsoftonline.com/t2/v2.0"},
		//! Two different API keys stay two accounts even with one label.
		{ID: "g", AuthMethod: AuthMethodAPIKey, KiroApiKey: "ksk_1", Email: "team@example.com"},
		{ID: "h", AuthMethod: AuthMethodAPIKey, KiroApiKey: "ksk_2", Email: "team@example.com"},
	})
	if len(groups) != 0 {
		t.Fatalf("groups = %v, want none", groupIDs(groups))
	}
}

func TestDuplicateGroupsEntraMatchesAcrossUserIDForms(t *testing.T) {
	issuer := "https://login.microsoftonline.com/t1/v2.0"
	groups := FindDuplicateGroups([]Account{
		{ID: "a", AuthMethod: AuthMethodExternalIdp, Provider: "AzureAD", Email: "me@contoso.com", IssuerURL: issuer, UserId: issuer + ".object"},
		{ID: "b", AuthMethod: AuthMethodExternalIdp, Provider: "AzureAD", Email: "me@contoso.com", IssuerURL: issuer + "/", UserId: "kiro-user-id"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "b"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
}

func TestDuplicateGroupsTransitive(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "x", AuthMethod: "social", Provider: "Google", Email: "x@example.com", RefreshToken: "rt-x"},
		{ID: "a", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", RefreshToken: "rt-1"},
		{ID: "b", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-1", Email: "dev@example.com"},
		{ID: "c", AuthMethod: "social", Provider: "Google", Email: "DEV@example.com", RefreshToken: "rt-3"},
		{ID: "k1", AuthMethod: AuthMethodAPIKey, KiroApiKey: "ksk_same"},
		{ID: "k2", AuthMethod: AuthMethodAPIKey, KiroApiKey: "ksk_same"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "b", "c"}, {"k1", "k2"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if want := []string{DuplicateReasonRefreshToken, DuplicateReasonEmail}; !reflect.DeepEqual(groups[0].Reasons, want) {
		t.Fatalf("reasons = %v, want %v", groups[0].Reasons, want)
	}
	if want := []string{DuplicateReasonAPIKey}; !reflect.DeepEqual(groups[1].Reasons, want) {
		t.Fatalf("api key reasons = %v, want %v", groups[1].Reasons, want)
	}
}

func TestDuplicateGroupsIgnoreEmptyFields(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", AuthMethod: "social", RefreshToken: " ", UserId: "", Email: ""},
		{ID: "b", AuthMethod: "social", RefreshToken: "", UserId: " ", Email: " "},
		{ID: "c", AuthMethod: "social"},
	})
	if len(groups) != 0 {
		t.Fatalf("empty fields grouped accounts: %v", groupIDs(groups))
	}
}

func TestSuggestKeeperPrefersHealthyThenLatestRefresh(t *testing.T) {
	healthy := func(id string, lastRefresh, expiresAt int64) Account {
		return Account{ID: id, Enabled: true, RefreshToken: "rt", LastRefresh: lastRefresh, ExpiresAt: expiresAt}
	}
	disabledNewest := healthy("disabled", 900, 900)
	disabledNewest.Enabled = false
	banned := healthy("banned", 800, 800)
	banned.BanStatus = "BANNED"

	group := []Account{disabledNewest, banned, healthy("older", 100, 500), healthy("newer", 200, 100)}
	if got := SuggestKeeper(group); got != "newer" {
		t.Fatalf("keeper = %q, want newer (healthy, latest refresh)", got)
	}
	tied := []Account{healthy("first", 100, 100), healthy("later-expiry", 100, 300), healthy("same", 100, 300)}
	if got := SuggestKeeper(tied); got != "later-expiry" {
		t.Fatalf("keeper = %q, want later-expiry, then the first listed", got)
	}
	if got := SuggestKeeper([]Account{disabledNewest, banned}); got != "disabled" {
		t.Fatalf("keeper among unhealthy = %q, want the latest refresh", got)
	}
}

func TestUpsertAccountAddsWhenNoDuplicate(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		first := Account{ID: "a", AuthMethod: "social", Provider: "Google", Email: "a@example.com", RefreshToken: "rt-a", Enabled: true}
		stored, updated, err := UpsertAccount(first)
		if err != nil || updated || stored.ID != "a" {
			t.Fatalf("first upsert = %+v updated=%v err=%v", stored, updated, err)
		}
		second := Account{ID: "b", AuthMethod: "social", Provider: "Google", Email: "b@example.com", RefreshToken: "rt-b", Enabled: true}
		if stored, updated, err := UpsertAccount(second); err != nil || updated || stored.ID != "b" {
			t.Fatalf("second upsert = %+v updated=%v err=%v", stored, updated, err)
		}
		if n := len(GetAccounts()); n != 2 {
			t.Fatalf("stored %d accounts, want 2", n)
		}
	})
}

func TestUpsertAccountUpdatesExistingTokens(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		var notified []string
		SetAccountsChangedHook(func(id string) { notified = append(notified, id) })
		t.Cleanup(func() { SetAccountsChangedHook(nil) })

		existing := Account{
			ID: "keep", AuthMethod: "idc", Provider: "BuilderId", Email: "dev@example.com",
			AccessToken: "at-old", RefreshToken: "rt-old", ClientID: "client-old", ClientSecret: "secret-old",
			Region: "us-east-1", ExpiresAt: 100, Enabled: true, RequestCount: 7,
		}
		if err := AddAccount(existing); err != nil {
			t.Fatalf("seed: %v", err)
		}
		stored, updated, err := UpsertAccount(Account{
			ID: "new", AuthMethod: "idc", Provider: "BuilderId", Email: "DEV@example.com", UserId: "u-1",
			AccessToken: "at-new", RefreshToken: "rt-new", ClientID: "client-new", ClientSecret: "secret-new",
			Region: "us-east-1", ExpiresAt: 900, Enabled: true, MachineId: "machine-new",
		})
		if err != nil || !updated {
			t.Fatalf("upsert updated=%v err=%v", updated, err)
		}
		if stored.ID != "keep" {
			t.Fatalf("stored id = %q, want the existing keep", stored.ID)
		}
		accounts := GetAccounts()
		if len(accounts) != 1 {
			t.Fatalf("stored %d accounts, want 1", len(accounts))
		}
		got := accounts[0]
		if got.AccessToken != "at-new" || got.RefreshToken != "rt-new" || got.ExpiresAt != 900 ||
			got.ClientID != "client-new" || got.ClientSecret != "secret-new" || got.UserId != "u-1" {
			t.Fatalf("credentials not moved onto the existing account: %+v", got)
		}
		if got.RequestCount != 7 || got.MachineId != "" {
			t.Fatalf("existing counters or machine id changed: %+v", got)
		}
		if len(notified) == 0 || notified[len(notified)-1] != "keep" {
			t.Fatalf("change hook ids = %v, want the existing id last", notified)
		}
	})
}

func TestUpsertAccountKeepsOperatorFieldsAndPinnedProfile(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		pinned := "arn:aws:codewhisperer:us-east-1:1:profile/PINNED"
		existing := Account{
			ID: "keep", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", RefreshToken: "rt-old",
			Nickname: "primary", Weight: 3, ProxyURL: "socks5://127.0.0.1:1080", MachineId: "machine-old",
			Enabled: false, Silent: true, BanStatus: "DISABLED", ProfileArn: pinned, ProfileArnPinned: true,
			TotalTokens: 42,
		}
		if err := AddAccount(existing); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, updated, err := UpsertAccount(Account{
			ID: "new", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", Nickname: "fresh",
			AccessToken: "at-new", ExpiresAt: 500, Enabled: true,
			ProfileArn: "arn:aws:codewhisperer:us-east-1:1:profile/OTHER",
		})
		if err != nil || !updated {
			t.Fatalf("upsert updated=%v err=%v", updated, err)
		}
		got := GetAccounts()[0]
		if got.Nickname != "primary" || got.Weight != 3 || got.ProxyURL != existing.ProxyURL || got.MachineId != "machine-old" {
			t.Fatalf("operator fields changed: %+v", got)
		}
		if got.Enabled || !got.Silent || got.BanStatus != "DISABLED" || got.TotalTokens != 42 {
			t.Fatalf("state or counters changed: %+v", got)
		}
		if got.ProfileArn != pinned || !got.ProfileArnPinned {
			t.Fatalf("pinned profile replaced: %q pinned=%v", got.ProfileArn, got.ProfileArnPinned)
		}
		if got.RefreshToken != "rt-old" || got.AccessToken != "at-new" || got.ExpiresAt != 500 {
			t.Fatalf("an access-only login must keep the stored refresh token: %+v", got)
		}
	})
}

func TestUpsertAccountRejectsDuplicateAPIKey(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		key := Account{ID: "k1", KiroApiKey: "ksk_dedup|eu-central-1", Enabled: true}
		if _, updated, err := UpsertAccount(key); err != nil || updated {
			t.Fatalf("first key updated=%v err=%v", updated, err)
		}
		key.ID = "k2"
		key.KiroApiKey = "ksk_dedup"
		if _, _, err := UpsertAccount(key); !errors.Is(err, ErrDuplicateKiroAPIKey) {
			t.Fatalf("second key err = %v, want ErrDuplicateKiroAPIKey", err)
		}
		other := Account{ID: "k3", KiroApiKey: "ksk_other", Email: GetAccounts()[0].Email, Enabled: true}
		if _, updated, err := UpsertAccount(other); err != nil || updated {
			t.Fatalf("a different key with the same label updated=%v err=%v", updated, err)
		}
		if n := len(GetAccounts()); n != 2 {
			t.Fatalf("stored %d accounts, want 2", n)
		}
	})
}

func TestUpsertAccountLiftsOnlyAnAuthFailureBan(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		seed := []Account{
			{ID: "dead", AuthMethod: "idc", Provider: "BuilderId", UserId: "u-dead", RefreshToken: "rt-dead",
				Enabled: false, BanStatus: "BANNED", BanReason: AuthFailureBanReason, BanTime: 123},
			{ID: "suspended", AuthMethod: "idc", Provider: "BuilderId", UserId: "u-suspended", RefreshToken: "rt-s",
				Enabled: false, BanStatus: "BANNED", BanReason: "AWS temporarily suspended - unusual user activity detected", BanTime: 123},
			{ID: "off", AuthMethod: "idc", Provider: "BuilderId", UserId: "u-off", RefreshToken: "rt-off",
				Enabled: false, BanStatus: "DISABLED", BanTime: 123},
			{ID: "silenced", AuthMethod: "idc", Provider: "BuilderId", UserId: "u-silenced", RefreshToken: "rt-silenced",
				Enabled: false, Silent: true, BanStatus: "BANNED", BanReason: AuthFailureBanReason, BanTime: 123},
		}
		for _, a := range seed {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		for _, a := range seed {
			stored, updated, err := UpsertAccount(Account{
				ID: "login-" + a.ID, AuthMethod: "idc", Provider: "BuilderId", UserId: a.UserId,
				AccessToken: "at-fresh", RefreshToken: "rt-fresh-" + a.ID, ExpiresAt: 900, Enabled: true,
			})
			if err != nil || !updated || stored.ID != a.ID {
				t.Fatalf("relogin of %s saved %q updated=%v err=%v", a.ID, stored.ID, updated, err)
			}
		}
		byID := map[string]Account{}
		for _, a := range GetAccounts() {
			byID[a.ID] = a
		}
		if got := byID["dead"]; !got.Enabled || got.BanStatus != "ACTIVE" || got.BanReason != "" || got.BanTime != 0 ||
			!IsHealthyAccount(&got) {
			t.Fatalf("a fresh login must lift the auth-failure ban: %+v", got)
		}
		for _, want := range seed[1:] {
			id, got := want.ID, byID[want.ID]
			if got.Enabled || got.BanStatus != want.BanStatus || got.BanReason != want.BanReason || got.Silent != want.Silent {
				t.Fatalf("%s state changed: %+v", id, got)
			}
			if got.RefreshToken != "rt-fresh-"+id {
				t.Fatalf("%s did not take the new token: %+v", id, got)
			}
		}
	})
}

func TestUpsertAccountUpdatesTheCopyAMergeWouldKeep(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		for _, a := range []Account{
			{ID: "stale", AuthMethod: "social", Provider: "Google", UserId: "u-1", RefreshToken: "rt-stale",
				Enabled: false, BanStatus: "DISABLED", LastRefresh: 900},
			{ID: "healthy", AuthMethod: "social", Provider: "Google", UserId: "u-1", RefreshToken: "rt-healthy",
				Enabled: true, LastRefresh: 100},
			{ID: "other", AuthMethod: "social", Provider: "Google", UserId: "u-2", RefreshToken: "rt-other", Enabled: true},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		stored, updated, err := UpsertAccount(Account{
			ID: "login", AuthMethod: "social", Provider: "Google", UserId: "u-1",
			AccessToken: "at-fresh", RefreshToken: "rt-fresh", ExpiresAt: 900, Enabled: true,
		})
		if err != nil || !updated || stored.ID != "healthy" {
			t.Fatalf("relogin saved %q updated=%v err=%v, want the healthy copy", stored.ID, updated, err)
		}
		byID := map[string]Account{}
		for _, a := range GetAccounts() {
			byID[a.ID] = a
		}
		if len(byID) != 3 || byID["healthy"].RefreshToken != "rt-fresh" || byID["stale"].RefreshToken != "rt-stale" {
			t.Fatalf("accounts after relogin = %+v", byID)
		}

		//! A copy banned for its dead token ranks as it will be once the login revives it.
		if err := SetAccountBanStatus("healthy", "DISABLED", ""); err != nil {
			t.Fatalf("disable: %v", err)
		}
		if err := AddAccount(Account{ID: "revivable", AuthMethod: "social", Provider: "Google", UserId: "u-1",
			RefreshToken: "rt-dead", BanStatus: "BANNED", BanReason: AuthFailureBanReason, LastRefresh: 50}); err != nil {
			t.Fatalf("seed revivable: %v", err)
		}
		stored, updated, err = UpsertAccount(Account{
			ID: "login-2", AuthMethod: "social", Provider: "Google", UserId: "u-1",
			RefreshToken: "rt-fresh-2", ExpiresAt: 950, Enabled: true,
		})
		if err != nil || !updated || stored.ID != "revivable" || !stored.Enabled {
			t.Fatalf("second relogin saved %+v updated=%v err=%v, want the revived copy", stored, updated, err)
		}
	})
}

func TestMergeAccountsSumsCountersAndRemovesOthers(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		var notified []string
		SetAccountsChangedHook(func(id string) { notified = append(notified, id) })
		t.Cleanup(func() { SetAccountsChangedHook(nil) })

		for _, a := range []Account{
			{ID: "keep", AuthMethod: "social", Provider: "Google", RefreshToken: "rt-1", ExpiresAt: 500, Nickname: ""},
			{ID: "other", AuthMethod: "idc", Email: "other@example.com", RefreshToken: "rt-o"},
			{ID: "dup", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", UserId: "u-1", RefreshToken: "rt-1", ExpiresAt: 100, Nickname: "copy"},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		notified = nil
		counters := AccountCounters{RequestCount: 12, ErrorCount: 3, TotalTokens: 400, TotalCredits: 1.5, LastUsed: 77}
		kept, err := MergeAccounts("keep", []string{"dup"}, counters)
		if err != nil {
			t.Fatalf("merge: %v", err)
		}
		accounts := GetAccounts()
		if len(accounts) != 2 || accounts[0].ID != "keep" || accounts[1].ID != "other" {
			t.Fatalf("accounts after merge = %+v", accounts)
		}
		got := accounts[0]
		if got.RequestCount != 12 || got.ErrorCount != 3 || got.TotalTokens != 400 || got.TotalCredits != 1.5 || got.LastUsed != 77 {
			t.Fatalf("counters = %+v", got)
		}
		if got.Email != "dev@example.com" || got.UserId != "u-1" || got.Nickname != "copy" {
			t.Fatalf("empty identity fields not filled: %+v", got)
		}
		if got.RefreshToken != "rt-1" || got.ExpiresAt != 500 || kept.ID != "keep" {
			t.Fatalf("keeper token changed although it was the freshest: %+v", got)
		}
		if !reflect.DeepEqual(notified, []string{"keep", "dup"}) {
			t.Fatalf("change hook ids = %v", notified)
		}

		if _, err := MergeAccounts("keep", []string{"gone"}, counters); !errors.Is(err, ErrAccountNotFound) {
			t.Fatalf("merge with a missing id err = %v, want ErrAccountNotFound", err)
		}
		if n := len(GetAccounts()); n != 2 {
			t.Fatalf("a failed merge changed the store: %d accounts", n)
		}
	})
}

func TestMergeAccountsTakesFreshestSameMethodToken(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		for _, a := range []Account{
			{ID: "keep", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", AccessToken: "at-old", RefreshToken: "rt-old", ExpiresAt: 100},
			{ID: "fresh", AuthMethod: "social", Provider: "Google", Email: "dev@example.com", AccessToken: "at-fresh", RefreshToken: "rt-fresh", ExpiresAt: 300},
			{ID: "other-method", AuthMethod: "idc", Provider: "Google", Email: "dev@example.com", AccessToken: "at-idc", RefreshToken: "rt-old", ClientID: "c", ExpiresAt: 900},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		if _, err := MergeAccounts("keep", []string{"fresh", "other-method"}, AccountCounters{}); err != nil {
			t.Fatalf("merge: %v", err)
		}
		accounts := GetAccounts()
		if len(accounts) != 1 {
			t.Fatalf("accounts after merge = %+v", accounts)
		}
		got := accounts[0]
		if got.AccessToken != "at-fresh" || got.RefreshToken != "rt-fresh" || got.ExpiresAt != 300 || got.ClientID != "" {
			t.Fatalf("keeper did not take the freshest same-method token: %+v", got)
		}
		if got.AuthMethod != "social" {
			t.Fatalf("auth method changed: %q", got.AuthMethod)
		}
	})
}

func TestMergeAccountsMovesBoundApiKeysToTheKeeper(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		for _, id := range []string{"keep", "copy", "other"} {
			if err := AddAccount(Account{ID: id, Email: id + "@example.com", RefreshToken: "rt-" + id, AuthMethod: "social", Provider: "Google", Enabled: true}); err != nil {
				t.Fatalf("seed %s: %v", id, err)
			}
		}
		onCopy, err := AddApiKey(ApiKeyEntry{Key: "sk-on-copy", Enabled: true, AccountIDs: []string{"copy", "other"}})
		if err != nil {
			t.Fatalf("add key: %v", err)
		}
		onBoth, err := AddApiKey(ApiKeyEntry{Key: "sk-on-both", Enabled: true, AccountIDs: []string{"keep", "copy"}})
		if err != nil {
			t.Fatalf("add key: %v", err)
		}
		unbound, err := AddApiKey(ApiKeyEntry{Key: "sk-unbound", Enabled: true})
		if err != nil {
			t.Fatalf("add key: %v", err)
		}
		if _, err := MergeAccounts("keep", []string{"copy"}, AccountCounters{}); err != nil {
			t.Fatalf("merge: %v", err)
		}
		if got := GetApiKeyEntry(onCopy.ID).AccountIDs; !reflect.DeepEqual(got, []string{"keep", "other"}) {
			t.Fatalf("key bound to the removed copy = %v, want [keep other]", got)
		}
		if got := GetApiKeyEntry(onBoth.ID).AccountIDs; !reflect.DeepEqual(got, []string{"keep"}) {
			t.Fatalf("key bound to both = %v, want [keep]", got)
		}
		if got := GetApiKeyEntry(unbound.ID).AccountIDs; len(got) != 0 {
			t.Fatalf("unbound key = %v, want every account", got)
		}
	})
}

// IAM SSO and SSO-token logins store no provider; Builder ID device login
// stores "BuilderId". An empty provider is unknown, so one Kiro user found
// through both paths is still one account. Two set, different providers stay
// apart.
func TestDuplicateGroupsTreatEmptyProviderAsUnknown(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "a", Provider: "BuilderId", AuthMethod: "idc", UserId: "u-1", Email: "u@example.com"},
		{ID: "b", Provider: "", AuthMethod: "idc", UserId: "u-1", Email: "u@example.com"},
		{ID: "c", Provider: "BuilderId", AuthMethod: "idc", Email: "v@example.com"},
		{ID: "d", Provider: "", AuthMethod: "idc", Email: "v@example.com"},
		{ID: "e", Provider: "Google", AuthMethod: "social", UserId: "u-9", Email: "w@example.com"},
		{ID: "f", Provider: "Github", AuthMethod: "social", UserId: "u-9", Email: "w@example.com"},
	})
	if got, want := groupIDs(groups), [][]string{{"a", "b"}, {"c", "d"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(groups[0].Reasons, []string{DuplicateReasonUserID}) || !reflect.DeepEqual(groups[1].Reasons, []string{DuplicateReasonEmail}) {
		t.Fatalf("reasons = %v / %v", groups[0].Reasons, groups[1].Reasons)
	}
}

func TestUpsertAccountMatchesAcrossEmptyProvider(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		if err := AddAccount(Account{ID: "a1", Email: "u@example.com", UserId: "user-1", AuthMethod: "idc", Provider: "BuilderId", RefreshToken: "rt-old", ClientID: "c1", Enabled: true}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		stored, updated, err := UpsertAccount(Account{ID: "a2", Email: "u@example.com", UserId: "user-1", AuthMethod: "idc", RefreshToken: "rt-new", ClientID: "c2", Enabled: true})
		if err != nil {
			t.Fatalf("upsert: %v", err)
		}
		if !updated || stored.ID != "a1" || stored.Provider != "BuilderId" || stored.RefreshToken != "rt-new" {
			t.Fatalf("upsert with no provider = %+v updated=%v, want a1 updated", stored, updated)
		}
		if n := len(GetAccounts()); n != 1 {
			t.Fatalf("stored %d accounts, want 1", n)
		}
		// A credentials import without a provider, after the token rotated.
		stored, updated, err = UpsertAccount(Account{ID: "a3", Email: "u@example.com", UserId: "user-1", AuthMethod: "idc", RefreshToken: "rt-rotated", Enabled: true})
		if err != nil || !updated || stored.ID != "a1" {
			t.Fatalf("second upsert = %+v updated=%v err=%v, want a1 updated", stored, updated, err)
		}
	})
}

// By email, an empty provider is unknown for IdC logins only. A social login
// with no provider (a credentials import without one, whose userId could not be
// read) is not matched by email to a stored social login of some provider: one
// email can be a Google and a Github user. By userId it still matches.
func TestDuplicateGroupsSocialEmailNeedsTheSameProvider(t *testing.T) {
	groups := FindDuplicateGroups([]Account{
		{ID: "gh", Provider: "Github", AuthMethod: "social", UserId: "u-gh", Email: "dev@example.com"},
		{ID: "np", Provider: "", AuthMethod: "social", Email: "dev@example.com"},
		{ID: "go", Provider: "Google", AuthMethod: "social", UserId: "u-go", Email: "ops@example.com"},
		{ID: "go2", Provider: "", AuthMethod: "social", UserId: "u-go", Email: "ops@example.com"},
		{ID: "x1", Provider: "", AuthMethod: "social", Email: "x@example.com"},
		{ID: "x2", Provider: "", AuthMethod: "social", Email: "x@example.com"},
	})
	if got, want := groupIDs(groups), [][]string{{"go", "go2"}, {"x1", "x2"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(groups[0].Reasons, []string{DuplicateReasonUserID}) || !reflect.DeepEqual(groups[1].Reasons, []string{DuplicateReasonEmail}) {
		t.Fatalf("reasons = %v / %v", groups[0].Reasons, groups[1].Reasons)
	}
}

func TestUpsertAccountSocialWithoutProviderDoesNotTakeOverByEmail(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		if err := AddAccount(Account{ID: "gh", Email: "dev@example.com", UserId: "u-gh", AuthMethod: "social", Provider: "Github", RefreshToken: "rt-gh", Enabled: true}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		stored, updated, err := UpsertAccount(Account{ID: "new", Email: "dev@example.com", AuthMethod: "social", RefreshToken: "rt-other", Enabled: true})
		if err != nil {
			t.Fatalf("upsert: %v", err)
		}
		if updated || stored.ID != "new" {
			t.Fatalf("upsert = %+v updated=%v, want a new account", stored, updated)
		}
		for _, a := range GetAccounts() {
			if a.ID == "gh" && a.RefreshToken != "rt-gh" {
				t.Fatal("the Github account's token was overwritten")
			}
		}
		if n := len(GetAccounts()); n != 2 {
			t.Fatalf("stored %d accounts, want 2", n)
		}
	})
}

// A copy that reaches Kiro only through its own proxy must not lose that route
// when it is merged into a keeper without one; a keeper's own proxy wins.
func TestMergeAccountsKeepsADonorProxyTheKeeperLacks(t *testing.T) {
	forEachStore(t, func(t *testing.T) {
		for _, a := range []Account{
			{ID: "keep", AuthMethod: "social", Email: "dev@example.com", RefreshToken: "rt-a", ExpiresAt: 300},
			{ID: "proxied", AuthMethod: "social", Email: "dev@example.com", RefreshToken: "rt-b", ExpiresAt: 100, ProxyURL: "socks5://u:p@sg-proxy:1080"},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		kept, err := MergeAccounts("keep", []string{"proxied"}, AccountCounters{})
		if err != nil {
			t.Fatalf("merge: %v", err)
		}
		if kept.ProxyURL != "socks5://u:p@sg-proxy:1080" || GetAccounts()[0].ProxyURL != kept.ProxyURL {
			t.Fatalf("keeper proxy = %q, want the donor's", kept.ProxyURL)
		}

		for _, a := range []Account{
			{ID: "keep2", AuthMethod: "social", Email: "two@example.com", RefreshToken: "rt-c", ExpiresAt: 300, ProxyURL: "http://own:8080"},
			{ID: "other2", AuthMethod: "social", Email: "two@example.com", RefreshToken: "rt-d", ExpiresAt: 100, ProxyURL: "http://donor:8080"},
		} {
			if err := AddAccount(a); err != nil {
				t.Fatalf("seed %s: %v", a.ID, err)
			}
		}
		kept, err = MergeAccounts("keep2", []string{"other2"}, AccountCounters{})
		if err != nil {
			t.Fatalf("merge: %v", err)
		}
		if kept.ProxyURL != "http://own:8080" {
			t.Fatalf("keeper proxy = %q, want its own", kept.ProxyURL)
		}
	})
}

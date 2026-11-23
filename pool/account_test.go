package pool

import (
	"errors"
	"kiro-proxy/config"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestOverageAccountsAreSkippedByDefault(t *testing.T) {
	p := &AccountPool{}
	normal := config.Account{ID: "normal"}
	overLimit := config.Account{ID: "over", UsageCurrent: 10, UsageLimit: 10}

	p.setAccountsLocked([]config.Account{normal, overLimit})

	for i := 0; i < 5; i++ {
		acc := p.GetNext()
		if acc == nil {
			t.Fatalf("expected an account")
		}
		if acc.ID == "over" {
			t.Fatalf("expected over-limit account to be skipped by default")
		}
	}
}

func TestOverageAccountsCanBeSelectedWhenAllowed(t *testing.T) {
	p := &AccountPool{}
	overLimit := config.Account{
		ID:            "over",
		UsageCurrent:  10,
		UsageLimit:    10,
		OverageStatus: "ENABLED",
	}

	p.setAccountsLocked([]config.Account{overLimit})

	acc := p.GetNext()
	if acc == nil {
		t.Fatalf("expected allowed overage account")
	}
	if acc.ID != "over" {
		t.Fatalf("expected overage account, got %q", acc.ID)
	}
}

func TestGlobalAllowOverUsageKeepsOverLimitAccountsInReloadedPool(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.UpdateAllowOverUsage(true); err != nil {
		t.Fatalf("enable allow over usage: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "over", Enabled: true, UsageCurrent: 10, UsageLimit: 10}); err != nil {
		t.Fatalf("add account: %v", err)
	}

	p := newTestPool()
	p.Reload()
	acc := p.GetNext()
	if acc == nil {
		t.Fatalf("expected over-limit account when global allow over-usage is enabled")
	}
	if acc.ID != "over" {
		t.Fatalf("expected over account, got %q", acc.ID)
	}
}

func TestUpstreamOverageEnabledOnlyAcceptsEnabledStatus(t *testing.T) {
	if !isUpstreamOverageEnabled(config.Account{OverageStatus: "ENABLED"}) {
		t.Fatalf("expected ENABLED overage status to be accepted")
	}
	if isUpstreamOverageEnabled(config.Account{OverageStatus: "DISABLED"}) {
		t.Fatalf("expected DISABLED overage status to be rejected")
	}
	if isUpstreamOverageEnabled(config.Account{}) {
		t.Fatalf("expected empty overage status to be rejected")
	}
}

func TestGetNextKeepsFiveMinuteTokenAvailable(t *testing.T) {
	p := &AccountPool{}
	account := config.Account{
		ID:          "acct-1",
		AccessToken: "access-token",
		ExpiresAt:   time.Now().Unix() + 300,
	}

	p.setAccountsLocked([]config.Account{account})

	got := p.GetNext()
	if got == nil {
		t.Fatalf("expected five-minute token to be available")
	}
	if got.ID != account.ID {
		t.Fatalf("expected account %q, got %q", account.ID, got.ID)
	}
}

func TestGetNextKeepsRefreshableNearExpiryTokenAvailable(t *testing.T) {
	p := &AccountPool{}
	account := config.Account{
		ID:           "acct-refreshable",
		AccessToken:  "access-token",
		RefreshToken: "refresh-token",
		ExpiresAt:    time.Now().Unix() + 60,
	}

	p.setAccountsLocked([]config.Account{account})

	got := p.GetNext()
	if got == nil {
		t.Fatalf("expected near-expiry account with refresh token to be available")
	}
	if got.ID != account.ID {
		t.Fatalf("expected account %q, got %q", account.ID, got.ID)
	}
}

func TestGetNextSkipsNearExpiryTokenWithoutRefreshToken(t *testing.T) {
	p := &AccountPool{}
	p.setAccountsLocked([]config.Account{
		{
			ID:          "acct-no-refresh",
			AccessToken: "access-token",
			ExpiresAt:   time.Now().Unix() + 60,
		},
	})

	if got := p.GetNext(); got != nil {
		t.Fatalf("expected near-expiry account without refresh token to be skipped, got %q", got.ID)
	}
}

func TestGetNextRotatesAcrossUsableAccounts(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "a"},
		config.Account{ID: "b"},
		config.Account{ID: "c"},
	)

	var got []string
	for i := 0; i < 6; i++ {
		acc := p.GetNext()
		if acc == nil {
			t.Fatalf("selection %d returned nil", i)
		}
		got = append(got, acc.ID)
	}

	want := []string{"a", "b", "c", "a", "b", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected rotation: got %v want %v", got, want)
		}
	}
}

func TestReloadDoesNotRestartRotationAtFirstAccount(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "a", Enabled: true}); err != nil {
		t.Fatalf("add account a: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "b", Enabled: true}); err != nil {
		t.Fatalf("add account b: %v", err)
	}

	p := newTestPool()
	p.Reload()
	first := p.GetNext()
	if first == nil || first.ID != "a" {
		t.Fatalf("expected first account a, got %#v", first)
	}

	p.Reload()
	second := p.GetNext()
	if second == nil || second.ID != "b" {
		t.Fatalf("expected reload to preserve rotation and select b, got %#v", second)
	}
}

// countPicks makes n weighted picks and counts them per account.
func countPicks(t *testing.T, p *AccountPool, n int) map[string]int {
	t.Helper()
	counts := make(map[string]int)
	for i := 0; i < n; i++ {
		acc := p.GetNext()
		if acc == nil {
			t.Fatalf("pick %d returned nil", i)
		}
		counts[acc.ID]++
	}
	return counts
}

// The live case behind the fix: twelve accounts at weight 1 and one at weight
// 10, last in the list. The heavy account served 1 pick in 22 when its slots sat
// in a row and the rotation skipped them after its first pick.
func TestWeightedRotationGivesEachAccountItsWeightShare(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for i := 0; i < 12; i++ {
		if err := config.AddAccount(config.Account{ID: "light-" + strconv.Itoa(i), Enabled: true, Weight: 1}); err != nil {
			t.Fatalf("add light account: %v", err)
		}
	}
	if err := config.AddAccount(config.Account{ID: "heavy", Enabled: true, Weight: 10}); err != nil {
		t.Fatalf("add heavy account: %v", err)
	}
	p := newTestPool()
	p.Reload()

	// 220 picks are ten whole cycles of 22 slots, so the shares are exact: 100 and 10 each.
	// Tolerance: 0 when the picks start at a cycle boundary; the test below covers a cursor mid-cycle.
	counts := countPicks(t, p, 220)
	if counts["heavy"] != 100 {
		t.Fatalf("heavy served %d of 220, want 100 (all counts: %v)", counts["heavy"], counts)
	}
	for i := 0; i < 12; i++ {
		if id := "light-" + strconv.Itoa(i); counts[id] != 10 {
			t.Fatalf("%s served %d of 220, want 10 (all counts: %v)", id, counts[id], counts)
		}
	}

	// From any point in the cycle, 22 picks in a row still give the heavy account its 10.
	for start := 0; start < 22; start++ {
		p.currentIndex = uint64(start)
		if got := countPicks(t, p, 22)["heavy"]; got != 10 {
			t.Fatalf("22 picks from slot %d: heavy served %d, want 10", start, got)
		}
	}
}

// The heavy account's slots are spread through the cycle, not bunched: with
// weight 10 of 22 it never serves two picks in a row within a cycle. The cycle
// starts and ends on it, so across the wrap it serves two in a row, never more.
func TestWeightedRotationSpreadsTheHeavyAccount(t *testing.T) {
	accounts := []config.Account{}
	for i := 0; i < 12; i++ {
		accounts = append(accounts, config.Account{ID: "light-" + strconv.Itoa(i)})
	}
	accounts = append(accounts, config.Account{ID: "heavy", Weight: 10})
	p := newTestPool(accounts...)

	run := 0
	for i := 0; i < 66; i++ {
		if p.GetNext().ID != "heavy" {
			run = 0
			continue
		}
		run++
		if run > 2 || (run == 2 && i%22 != 0) {
			t.Fatalf("pick %d: heavy served %d in a row", i, run)
		}
	}
}

// An account heavier than all the others together must repeat: skipping it to
// avoid a repeat would cut it to an equal share.
func TestWeightedRotationRepeatsADominantAccount(t *testing.T) {
	p := newTestPool(config.Account{ID: "heavy", Weight: 5}, config.Account{ID: "normal"})
	counts := countPicks(t, p, 60)
	if counts["heavy"] != 50 || counts["normal"] != 10 {
		t.Fatalf("counts = %v, want heavy 50 and normal 10", counts)
	}
}

func TestWeightedRotationWithEqualWeightsIsPlainRoundRobin(t *testing.T) {
	// Weight 0 (unset) counts as 1, and equal weights above 1 rotate the same way.
	for _, weight := range []int{0, 1, 4} {
		p := newTestPool(
			config.Account{ID: "a", Weight: weight},
			config.Account{ID: "b", Weight: weight},
			config.Account{ID: "c", Weight: weight},
		)
		var got []string
		for i := 0; i < 9; i++ {
			got = append(got, p.GetNext().ID)
		}
		want := []string{"a", "b", "c", "a", "b", "c", "a", "b", "c"}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("weight %d: rotation = %v, want %v", weight, got, want)
			}
		}
	}
}

// While an account cannot serve, the others keep their weights between them.
func TestWeightedRotationKeepsRatioWhileAnAccountCools(t *testing.T) {
	p := newTestPool(config.Account{ID: "a", Weight: 2}, config.Account{ID: "b"}, config.Account{ID: "c"})
	p.cooldowns["b"] = time.Now().Add(time.Minute)
	counts := countPicks(t, p, 30)
	if counts["a"] != 20 || counts["c"] != 10 || counts["b"] != 0 {
		t.Fatalf("counts with b cooling = %v, want a 20 and c 10", counts)
	}
}

func TestRotationOrderReducesWeightsByTheirCommonDivisor(t *testing.T) {
	order := rotationOrder([]config.Account{{ID: "a", Weight: 10}, {ID: "b", Weight: 20}})
	if len(order) != 3 {
		t.Fatalf("cycle = %v, want 3 slots for weights 10 and 20", order)
	}
	if rotationOrder(nil) != nil {
		t.Fatal("an empty pool has no cycle")
	}
}

// A weight over the cap (a hand-edited config or an import; the admin API refuses one) counts as
// the cap. The cycle has a slot per unit of weight, so an uncapped 1e10 exhausted memory on every
// reload, startup included.
func TestRotationOrderCapsAHugeWeight(t *testing.T) {
	order := rotationOrder([]config.Account{{ID: "a", Weight: 1e10}, {ID: "b"}, {ID: "c", Weight: -5}})
	if want := config.MaxAccountWeight + 2; len(order) != want {
		t.Fatalf("cycle has %d slots, want %d (a at the cap, b and c at 1)", len(order), want)
	}
	p := newTestPool(config.Account{ID: "a", Weight: 1e10}, config.Account{ID: "b"})
	counts := countPicks(t, p, config.MaxAccountWeight+1)
	if counts["a"] != config.MaxAccountWeight || counts["b"] != 1 {
		t.Fatalf("counts = %v, want a %d and b 1", counts, config.MaxAccountWeight)
	}
}

func TestGetNextForModelRotatesAcrossMatchingAccounts(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "a"},
		config.Account{ID: "b"},
		config.Account{ID: "c"},
	)
	p.SetModelList("a", []string{"claude-sonnet"})
	p.SetModelList("b", []string{"other-model"})
	p.SetModelList("c", []string{"claude-sonnet"})

	var got []string
	for i := 0; i < 4; i++ {
		acc := p.GetNextForModel("claude-sonnet")
		if acc == nil {
			t.Fatalf("selection %d returned nil", i)
		}
		got = append(got, acc.ID)
	}

	want := []string{"a", "c", "a", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected model rotation: got %v want %v", got, want)
		}
	}
}

func TestSingleUsableAccountCanRepeat(t *testing.T) {
	p := newTestPool(config.Account{ID: "only"})

	first := p.GetNext()
	second := p.GetNext()
	if first == nil || second == nil || first.ID != "only" || second.ID != "only" {
		t.Fatalf("expected single account to remain selectable, got %#v then %#v", first, second)
	}
}

func TestIsAuthFailureRecognizes401And403(t *testing.T) {
	positives := []string{
		"HTTP 401 from server",
		"received 403 Forbidden",
		"bad credentials",
		"invalid_grant",
		"invalid_token",
		"token expired",
		"token has expired",
		"unauthorized",
	}
	for _, msg := range positives {
		if !IsAuthFailure(errors.New(msg)) {
			t.Errorf("IsAuthFailure(%q) = false, want true", msg)
		}
	}
}

func TestIsAuthFailureIgnoresFalsePositives(t *testing.T) {

	negatives := []string{
		"status code 4011 found",
		"error 14013 exceeded",
		"request id req-401abc failed upstream",
		"some random error",
		"status 200 OK",
	}
	for _, msg := range negatives {
		if IsAuthFailure(errors.New(msg)) {
			t.Errorf("IsAuthFailure(%q) = true, want false", msg)
		}
	}
}

func TestIsAuthFailureNilError(t *testing.T) {
	if IsAuthFailure(nil) {
		t.Fatal("IsAuthFailure(nil) = true, want false")
	}
}

func TestIsSuspensionErrorDetectsKnownMessages(t *testing.T) {
	positives := []string{
		"account temporarily_suspended",
		"account temporarily suspended",
		"no available kiro profile",
		"No Available Kiro Profile",
	}
	for _, msg := range positives {
		if !IsSuspensionError(errors.New(msg)) {
			t.Errorf("IsSuspensionError(%q) = false, want true", msg)
		}
	}
}

func TestIsSuspensionErrorIgnoresUnrelatedErrors(t *testing.T) {
	negatives := []string{
		"some other error",
		"unauthorized",
		"429 too many requests",
	}
	for _, msg := range negatives {
		if IsSuspensionError(errors.New(msg)) {
			t.Errorf("IsSuspensionError(%q) = true, want false", msg)
		}
	}
}

func TestIsSuspensionErrorNilError(t *testing.T) {
	if IsSuspensionError(nil) {
		t.Fatal("IsSuspensionError(nil) = true, want false")
	}
}

func newTestPool(accounts ...config.Account) *AccountPool {
	p := &AccountPool{
		cooldowns:   make(map[string]time.Time),
		errorCounts: make(map[string]int),
		modelLists:  make(map[string]map[string]bool),
	}
	p.setAccountsLocked(accounts)
	return p
}

func TestGetNextForModelExcludingSkipsExcludedAccounts(t *testing.T) {
	p := newTestPool(
		config.Account{ID: "a"},
		config.Account{ID: "b"},
	)
	excluded := map[string]bool{"a": true}
	for i := 0; i < 5; i++ {
		acc := p.GetNextForModelExcluding("model", excluded)
		if acc == nil {
			t.Fatal("expected account b, got nil")
		}
		if acc.ID == "a" {
			t.Fatalf("excluded account a was returned on iteration %d", i)
		}
	}
}

func TestGetNextForModelExcludingReturnsNilWhenAllExcluded(t *testing.T) {
	p := newTestPool(config.Account{ID: "only"})
	acc := p.GetNextForModelExcluding("model", map[string]bool{"only": true})
	if acc != nil {
		t.Fatalf("expected nil when only account is excluded, got %q", acc.ID)
	}
}

func TestGetNextForModelExcludingReturnsNilOnEmptyPool(t *testing.T) {
	p := newTestPool()
	acc := p.GetNextForModelExcluding("model", map[string]bool{})
	if acc != nil {
		t.Fatalf("expected nil for empty pool, got %q", acc.ID)
	}
}

func TestReturnedAccountsAreSnapshots(t *testing.T) {
	p := newTestPool(config.Account{
		ID:           "acct",
		AccessToken:  "pool-access",
		RefreshToken: "pool-refresh",
	})

	next := p.GetNext()
	if next == nil {
		t.Fatal("expected account from GetNext")
	}
	next.AccessToken = "request-local-access"
	next.RefreshToken = "request-local-refresh"

	byID := p.GetByID("acct")
	if byID == nil {
		t.Fatal("expected account from GetByID")
	}
	if byID.AccessToken != "pool-access" || byID.RefreshToken != "pool-refresh" {
		t.Fatalf("GetNext returned shared account pointer, pool now has access=%q refresh=%q", byID.AccessToken, byID.RefreshToken)
	}

	p.cooldowns["acct"] = time.Now().Add(time.Minute)
	cooldown := p.GetNext()
	if cooldown != nil {
		t.Fatalf("expected active cooldown to block selection, got %#v", cooldown)
	}
}

func TestGetNextAndUpdateTokenCanRunConcurrently(t *testing.T) {
	p := newTestPool(config.Account{
		ID:           "acct",
		AccessToken:  "initial-access",
		RefreshToken: "initial-refresh",
		ExpiresAt:    time.Now().Add(time.Hour).Unix(),
	})

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := 0; i < 2000; i++ {
			p.UpdateToken("acct", "access-"+strconv.Itoa(i), "refresh-"+strconv.Itoa(i), time.Now().Add(time.Hour).Unix())
		}
	}()

	go func() {
		defer wg.Done()
		for i := 0; i < 2000; i++ {
			acc := p.GetNext()
			if acc == nil {
				t.Errorf("expected account on iteration %d", i)
				return
			}
			_ = len(acc.AccessToken)
			acc.AccessToken = "request-local-" + strconv.Itoa(i)
			if latest := p.GetByID(acc.ID); latest != nil {
				_ = len(latest.AccessToken)
			}
		}
	}()

	wg.Wait()
}

func TestDisableAccountSetsCooldown(t *testing.T) {

	cfgFile := filepath.Join(t.TempDir(), "kiro.db")
	if err := config.Init(cfgFile); err != nil {
		t.Fatalf("config.Init: %v", err)
	}

	p := newTestPool()
	p.DisableAccount("test-id", "test reason")

	p.mu.RLock()
	cooldown, ok := p.cooldowns["test-id"]
	p.mu.RUnlock()

	if !ok {
		t.Fatal("expected cooldown to be set after DisableAccount")
	}

	minExpected := time.Now().Add(23 * time.Hour)
	if cooldown.Before(minExpected) {
		t.Fatalf("expected cooldown >= 23h in future, got %v", cooldown)
	}
}

func TestGetNextExcludingSkipsExcludedAccount(t *testing.T) {
	p := newTestPool(config.Account{ID: "a", Enabled: true}, config.Account{ID: "b", Enabled: true})
	p.currentIndex = ^uint64(0)

	acc := p.GetNextExcluding(map[string]bool{"a": true})
	if acc == nil || acc.ID != "b" {
		t.Fatalf("expected account b, got %#v", acc)
	}
}

func TestGetNextForModelExcludingSkipsExcludedAccount(t *testing.T) {
	p := newTestPool(config.Account{ID: "a", Enabled: true}, config.Account{ID: "b", Enabled: true})
	p.currentIndex = ^uint64(0)
	p.SetModelList("a", []string{"claude-sonnet-4.5"})
	p.SetModelList("b", []string{"claude-sonnet-4.5"})

	acc := p.GetNextForModelExcluding("claude-sonnet-4.5", map[string]bool{"a": true})
	if acc == nil || acc.ID != "b" {
		t.Fatalf("expected account b, got %#v", acc)
	}
}

func TestOffersModel(t *testing.T) {
	if !newTestPool().OffersModel("anything") {
		t.Fatal("empty pool must not blame the model")
	}
	p := newTestPool(config.Account{ID: "a"}, config.Account{ID: "b"})
	if !p.OffersModel("x") {
		t.Fatal("accounts without a model list may serve any model")
	}
	p.SetModelList("a", []string{"claude-sonnet-4.5"})
	if !p.OffersModel("x") {
		t.Fatal("account b has no list, so x may still be served")
	}
	p.SetModelList("b", []string{"Claude-Haiku-4.5"})
	if !p.OffersModel(" claude-haiku-4.5 ") || !p.OffersModel("claude-sonnet-4.5") {
		t.Fatal("listed models must be offered, case and space insensitive")
	}
	if p.OffersModel("no-such-model") {
		t.Fatal("a model no account lists must not be offered")
	}
}

func TestOffersModelCountsOverLimitAccountsOutOfRotation(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "pro", Enabled: true, UsageCurrent: 10, UsageLimit: 10}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "free", Enabled: true}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := newTestPool()
	p.Reload()
	p.SetModelList("pro", []string{"claude-opus-5", "claude-sonnet-5"})
	p.SetModelList("free", []string{"claude-sonnet-5"})

	if acc := p.GetNextForModel("claude-opus-5"); acc != nil {
		t.Fatalf("over-limit account must stay out of rotation, got %q", acc.ID)
	}
	if !p.OffersModel("claude-opus-5") {
		t.Fatal("a model only an over-limit account lists is a quota problem, not an unknown model")
	}
	if p.OffersModel("no-such-model") {
		t.Fatal("a model no enabled account lists must not be offered")
	}
}

func TestRecordOutcomeCountsRequestsAndErrorsAndPersists(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "live", Enabled: true, Weight: 2}); err != nil {
		t.Fatalf("add live account: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "off", Enabled: false, RequestCount: 4, ErrorCount: 1, TotalTokens: 40}); err != nil {
		t.Fatalf("add disabled account: %v", err)
	}
	p := &AccountPool{cooldowns: map[string]time.Time{}, errorCounts: map[string]int{}, modelLists: map[string]map[string]bool{}}
	p.Reload()

	p.RecordOutcome("live", true, 30, 0.5)
	p.RecordOutcome("live", false, 0, 0)
	//! Disabled mid-request: the request still counts, on the stored row.
	p.RecordOutcome("off", false, 5, 0)
	p.RecordOutcome("", true, 1, 1)

	for _, acc := range p.GetAllAccounts() {
		if acc.ID == "live" && (acc.RequestCount != 2 || acc.ErrorCount != 1 || acc.TotalTokens != 30 || acc.TotalCredits != 0.5 || acc.LastUsed == 0) {
			t.Fatalf("pool copy of live = %+v", acc)
		}
	}
	stored := map[string]config.Account{}
	for _, acc := range config.GetAccounts() {
		stored[acc.ID] = acc
	}
	if got := stored["live"]; got.RequestCount != 2 || got.ErrorCount != 1 || got.TotalTokens != 30 {
		t.Fatalf("persisted live = %+v", got)
	}
	if got := stored["off"]; got.RequestCount != 5 || got.ErrorCount != 2 || got.TotalTokens != 45 || got.LastUsed == 0 {
		t.Fatalf("persisted off = %+v", got)
	}
}

func TestAddUsageLeavesRequestCountAlone(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if err := config.AddAccount(config.Account{ID: "a", Enabled: true, RequestCount: 3, TotalTokens: 10}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := &AccountPool{cooldowns: map[string]time.Time{}, errorCounts: map[string]int{}, modelLists: map[string]map[string]bool{}}
	p.Reload()

	p.AddUsage("a", 25, 0.4)
	p.AddUsage("a", 0, 0)

	for _, acc := range config.GetAccounts() {
		if acc.ID == "a" && (acc.RequestCount != 3 || acc.ErrorCount != 0 || acc.TotalTokens != 35 || acc.TotalCredits != 0.4 || acc.LastUsed == 0) {
			t.Fatalf("persisted a = %+v", acc)
		}
	}
}

// A model Kiro refused for an account stays away from it, even while its list is unknown (which
// lets every model through) or still names the model, until its next model listing.
func TestRefusedModelIsSkippedUntilTheNextListing(t *testing.T) {
	p := newTestPool(config.Account{ID: "unknown"}, config.Account{ID: "listed"}, config.Account{ID: "other"})
	p.SetModelList("listed", []string{"model-a", "model-b"})
	p.MarkModelRefused("unknown", "Model-A ")
	p.MarkModelRefused("listed", "model-a")

	for i := 0; i < 6; i++ {
		if acc := p.GetNextForModel("model-a"); acc == nil || acc.ID != "other" {
			t.Fatalf("pick %d for model-a = %v, want other", i, acc)
		}
	}
	got := map[string]bool{}
	for i := 0; i < 3; i++ {
		got[p.GetNextForModel("model-b").ID] = true
	}
	if !got["unknown"] || !got["listed"] {
		t.Fatalf("model-b picks = %v, want the refusal to cover model-a only", got)
	}

	p.SetModelList("listed", []string{"model-a"})
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		seen[p.GetNextForModel("model-a").ID] = true
	}
	if !seen["listed"] || seen["unknown"] {
		t.Fatalf("model-a picks after listed's new listing = %v, want listed back and unknown still out", seen)
	}

	p.MarkModelRefused("other", "model-a")
	if p.OffersModel("model-a") != true {
		t.Fatal("listed lists model-a again, so the pool offers it")
	}
	p.MarkModelRefused("listed", "model-a")
	if p.OffersModel("model-a") {
		t.Fatal("every account refused model-a, yet the pool still offers it")
	}
}

// A change run by ReloadAfter saves counters read from the pool; a request finishing meanwhile
// must wait and count on top of them, not write its older counters over them.
func TestReloadAfterHoldsCounterWritesUntilTheChangeIsSaved(t *testing.T) {
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, a := range []config.Account{{ID: "a", Enabled: true, RequestCount: 5}, {ID: "b", Enabled: true, RequestCount: 7}} {
		if err := config.AddAccount(a); err != nil {
			t.Fatal(err)
		}
	}
	p := newTestPool()
	p.Reload()

	done := make(chan struct{})
	err := p.ReloadAfter(func(stats map[string]config.Account) error {
		go func() {
			p.RecordOutcome("a", true, 0, 0)
			close(done)
		}()
		time.Sleep(50 * time.Millisecond)
		select {
		case <-done:
			t.Error("a request saved its counters while the change held them")
		default:
		}
		sum := stats["a"].RequestCount + stats["b"].RequestCount
		return config.UpdateAccountStats("a", sum, 0, 0, 0, 0)
	})
	if err != nil {
		t.Fatal(err)
	}
	<-done
	for _, a := range config.GetAccounts() {
		if a.ID == "a" && a.RequestCount != 13 {
			t.Fatalf("a counts %d requests, want the sum 12 plus the one that finished", a.RequestCount)
		}
	}
}

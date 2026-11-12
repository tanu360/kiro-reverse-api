package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

func authBanned(id string) config.Account {
	return config.Account{ID: id, Email: id + "@example.com", AccessToken: "token", BanStatus: "BANNED", BanReason: banReasonAuthFailed, BanTime: 1}
}

func reban(t *testing.T, p *accountpool.AccountPool, id string) {
	t.Helper()
	acc := storedHealAccount(t, id)
	acc.Enabled = false
	acc.BanStatus = "BANNED"
	acc.BanReason = banReasonAuthFailed
	if err := config.UpdateAccount(id, acc); err != nil {
		t.Fatalf("reban %s: %v", id, err)
	}
	p.Reload()
}

// testHealer is a healer on a clock the test moves.
type testHealer struct {
	*selfHealer
	at time.Time
}

func newTestHealer() *testHealer {
	h := &testHealer{selfHealer: newSelfHealer(), at: time.Now()}
	h.now = func() time.Time { return h.at }
	return h
}

func (h *testHealer) advance(d time.Duration) { h.at = h.at.Add(d) }

// healEvents collects account_heal payloads published while the test runs.
func healEvents(t *testing.T) func() []string {
	t.Helper()
	b := getBroadcaster()
	id, ch := b.Subscribe()
	var mu sync.Mutex
	var got []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		for evt := range ch {
			if evt.Type == eventAccountHeal {
				mu.Lock()
				got = append(got, evt.Payload)
				mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() {
		b.Unsubscribe(id)
		<-done
	})
	return func() []string {
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), got...)
	}
}

func TestPlanSelfHealSkipsSuspendedManualSilentAndQuota(t *testing.T) {
	now := time.Now()
	accounts := []config.Account{
		authBanned("auth"),
		{ID: "suspended", AccessToken: "t", BanStatus: "BANNED", BanReason: banReasonSuspended},
		{ID: "manual", AccessToken: "t", BanStatus: "DISABLED", BanReason: banReasonAuthFailed},
		func() config.Account { a := authBanned("silent"); a.Silent = true; return a }(),
		authBanned("quota-held"),
		func() config.Account {
			a := authBanned("dead-token")
			a.ExpiresAt = now.Add(-time.Hour).Unix()
			a.RefreshToken = ""
			return a
		}(),
		func() config.Account { a := authBanned("over-limit"); a.UsageCurrent, a.UsageLimit = 10, 10; return a }(),
	}
	view := accountpool.HealView{Cooled: []string{"throttled"}, Held: map[string]bool{"quota-held": true}}
	banned, cooled, ok := planSelfHeal(accounts, view, now)
	if !ok || len(banned) != 1 || banned[0] != "auth" || len(cooled) != 1 || cooled[0] != "throttled" {
		t.Fatalf("plan = banned %v cooled %v ok %v, want only auth and throttled", banned, cooled, ok)
	}

	view.Servable = true
	if _, _, ok := planSelfHeal(accounts, view, now); ok {
		t.Fatal("must not heal while some account can still serve")
	}
	if _, _, ok := planSelfHeal(accounts[1:4], accountpool.HealView{}, now); ok {
		t.Fatal("suspended, manual and silent accounts alone are nothing to heal")
	}
}

func TestSelfHealRestoresAuthBannedAccounts(t *testing.T) {
	p := setupHealTest(t, authBanned("heal-a"), authBanned("heal-b"),
		config.Account{ID: "heal-suspended", AccessToken: "t", BanStatus: "BANNED", BanReason: banReasonSuspended})
	events := healEvents(t)
	s := newTestHealer()
	if p.GetNext() != nil {
		t.Fatal("setup: banned accounts must not serve")
	}
	if !s.try(p) {
		t.Fatal("heal did not run on a dead pool")
	}
	for _, id := range []string{"heal-a", "heal-b"} {
		if got := storedHealAccount(t, id); !got.Enabled || got.BanStatus != "ACTIVE" || got.BanReason != "" || got.BanTime != 0 {
			t.Fatalf("%s after heal: %+v", id, got)
		}
	}
	if got := storedHealAccount(t, "heal-suspended"); got.Enabled || got.BanReason != banReasonSuspended {
		t.Fatalf("a Kiro suspension was lifted: %+v", got)
	}
	if p.GetNext() == nil {
		t.Fatal("healed accounts are not back in rotation")
	}
	if st := s.snapshot(); st.Rounds != 1 || st.LastHealed != 2 || st.LastHealAt != s.at.Unix() {
		t.Fatalf("state after heal = %+v", st)
	}
	if got := events(); len(got) != 1 || got[0] != "healed:2" {
		t.Fatalf("events = %v, want [healed:2]", got)
	}
}

func TestSelfHealClearsThrottleButKeepsQuotaCooldown(t *testing.T) {
	p := setupHealTest(t,
		config.Account{ID: "cool-throttle", Enabled: true, AccessToken: "t"},
		config.Account{ID: "cool-quota", Enabled: true, AccessToken: "t", NextResetDate: "2099-01-01"},
	)
	t.Cleanup(func() { p.RecordSuccess("cool-quota") })
	p.RecordThrottleError("cool-throttle", 0)
	p.RecordQuotaError("cool-quota", 0)
	waitForCooldownSaved(t, "cool-throttle")
	waitForCooldownSaved(t, "cool-quota")
	if p.GetNext() != nil {
		t.Fatal("setup: both accounts must be cooling")
	}

	s := newTestHealer()
	if !s.try(p) {
		t.Fatal("heal did not clear the throttle cooldown")
	}
	if got := p.CooldownKindOf("cool-throttle"); got != "" {
		t.Fatalf("throttle cooldown kind after heal = %q, want none", got)
	}
	if got := p.CooldownKindOf("cool-quota"); got != accountpool.CooldownQuota {
		t.Fatalf("quota cooldown kind after heal = %q, want quota", got)
	}
	if left := time.Until(p.CooldownUntil("cool-quota")); left < 24*time.Hour {
		t.Fatalf("quota cooldown shortened to %v", left)
	}
	if acc := p.GetNext(); acc == nil || acc.ID != "cool-throttle" {
		t.Fatalf("pick after heal = %v, want cool-throttle", acc)
	}
}

func TestSelfHealSkipsQuotaOnlyPool(t *testing.T) {
	p := setupHealTest(t, config.Account{ID: "only-quota", Enabled: true, AccessToken: "t", NextResetDate: "2099-01-01"})
	t.Cleanup(func() { p.RecordSuccess("only-quota") })
	p.RecordQuotaError("only-quota", 0)
	waitForCooldownSaved(t, "only-quota")
	if newTestHealer().try(p) {
		t.Fatal("a pool held only by quota must not heal")
	}
}

func TestSelfHealSkipsWhileAnAccountCanServe(t *testing.T) {
	p := setupHealTest(t, authBanned("serve-banned"), config.Account{ID: "serve-ok", Enabled: true, AccessToken: "t"})
	if newTestHealer().try(p) {
		t.Fatal("healed although an account can serve")
	}
	if got := storedHealAccount(t, "serve-banned"); got.Enabled {
		t.Fatal("banned account re-enabled while the pool could serve")
	}
}

func TestSelfHealDisabledDoesNothing(t *testing.T) {
	p := setupHealTest(t, authBanned("off-a"))
	off := false
	if err := config.UpdateSelfHealSettings(&off, nil, nil); err != nil {
		t.Fatal(err)
	}
	if newTestHealer().try(p) {
		t.Fatal("heal ran with the setting off")
	}
	if got := storedHealAccount(t, "off-a"); got.Enabled {
		t.Fatal("account re-enabled with self-heal off")
	}
}

func TestSelfHealRespectsMinInterval(t *testing.T) {
	p := setupHealTest(t, authBanned("gap-a"))
	s := newTestHealer()
	if !s.try(p) {
		t.Fatal("first heal did not run")
	}
	reban(t, p, "gap-a")
	s.advance(config.GetSelfHealInterval() - time.Second)
	if s.try(p) {
		t.Fatal("healed again inside the minimum interval")
	}
	s.advance(time.Second)
	if !s.try(p) {
		t.Fatal("heal did not run once the interval passed")
	}
	if got := s.snapshot().Rounds; got != 2 {
		t.Fatalf("rounds = %d, want 2", got)
	}
}

func TestSelfHealHaltsAfterMaxRoundsAndPublishes(t *testing.T) {
	p := setupHealTest(t, authBanned("cap-a"))
	rounds := 2
	if err := config.UpdateSelfHealSettings(nil, nil, &rounds); err != nil {
		t.Fatal(err)
	}
	events := healEvents(t)
	s := newTestHealer()
	for i := 0; i < rounds; i++ {
		if !s.try(p) {
			t.Fatalf("heal %d did not run", i+1)
		}
		reban(t, p, "cap-a")
		s.advance(config.GetSelfHealInterval())
	}
	if s.try(p) {
		t.Fatal("healed past the round cap")
	}
	if got := storedHealAccount(t, "cap-a"); got.Enabled {
		t.Fatal("account re-enabled past the cap")
	}
	st := s.snapshot()
	if !st.Halted || st.HaltedAt != s.at.Unix() || st.Rounds != rounds {
		t.Fatalf("state after cap = %+v", st)
	}
	s.advance(config.GetSelfHealInterval())
	if s.try(p) {
		t.Fatal("a halted healer healed")
	}
	if got := events(); strings.Join(got, ",") != "healed:1,healed:1,halted:2" {
		t.Fatalf("events = %v, want two heals then one halt", got)
	}
}

func TestSelfHealZeroMaxRoundsIsUnlimited(t *testing.T) {
	p := setupHealTest(t, authBanned("free-a"))
	zero := 0
	if err := config.UpdateSelfHealSettings(nil, nil, &zero); err != nil {
		t.Fatal(err)
	}
	s := newTestHealer()
	for i := 0; i < config.DefaultSelfHealMaxRounds+3; i++ {
		if !s.try(p) {
			t.Fatalf("heal %d did not run with no round cap", i+1)
		}
		reban(t, p, "free-a")
		s.advance(config.GetSelfHealInterval())
	}
	if s.snapshot().Halted {
		t.Fatal("halted with no round cap")
	}
}

func TestSelfHealSuccessResetsRoundsAndHalt(t *testing.T) {
	p := setupHealTest(t, authBanned("ok-a"))
	one := 1
	if err := config.UpdateSelfHealSettings(nil, nil, &one); err != nil {
		t.Fatal(err)
	}
	events := healEvents(t)
	s := newTestHealer()
	if !s.try(p) {
		t.Fatal("heal did not run")
	}
	reban(t, p, "ok-a")
	s.advance(config.GetSelfHealInterval())
	if s.try(p) || !s.snapshot().Halted {
		t.Fatal("expected a halt after one round")
	}

	s.noteSuccess()
	if st := s.snapshot(); st.Rounds != 0 || st.Halted {
		t.Fatalf("state after a success = %+v", st)
	}
	if s.armed.Load() {
		t.Fatal("a reset healer must leave the success path lock-free")
	}
	s.noteSuccess()
	if !s.try(p) {
		t.Fatal("heal did not run again after a success")
	}
	if got := events(); strings.Join(got, ",") != "healed:1,halted:1,recovered,healed:1" {
		t.Fatalf("events = %v", got)
	}
}

func TestSelfHealStateSurvivesReload(t *testing.T) {
	p := setupHealTest(t, authBanned("keep-a"))
	s := newTestHealer()
	if !s.try(p) {
		t.Fatal("heal did not run")
	}
	reban(t, p, "keep-a")

	restarted := newTestHealer()
	restarted.at = s.at.Add(time.Minute)
	if restarted.try(p) {
		t.Fatal("a restart skipped the minimum interval")
	}
	if st := restarted.snapshot(); st.Rounds != 1 || st.LastHealAt != s.at.Unix() {
		t.Fatalf("reloaded state = %+v", st)
	}
	if !restarted.armed.Load() {
		t.Fatal("a reloaded healer with rounds must reset on the next success")
	}
	restarted.noteSuccess()
	if got, err := config.LoadSelfHealState(); err != nil || got.Rounds != 0 {
		t.Fatalf("saved state after a success = %+v, %v", got, err)
	}
}

func TestSelfHealClockGoingBackRestartsInterval(t *testing.T) {
	p := setupHealTest(t, authBanned("skew-a"))
	if err := config.SaveSelfHealState(config.SelfHealState{LastHealAt: time.Now().Add(48 * time.Hour).Unix(), Rounds: 1}); err != nil {
		t.Fatal(err)
	}
	s := newTestHealer()
	if s.try(p) {
		t.Fatal("healed right after a clock jump back")
	}
	s.advance(config.GetSelfHealInterval())
	if !s.try(p) {
		t.Fatal("a heal time in the future blocked healing past one interval")
	}
}

func TestPickAccountHealsEmptyPool(t *testing.T) {
	p := setupHealTest(t, authBanned("pick-a"))
	old := healer
	healer = newSelfHealer()
	t.Cleanup(func() { healer = old })
	h := &Handler{pool: p, affinity: newSessionAffinity()}

	if acc := h.pickAccount(testKiroPayload(), "claude-sonnet-4.5", map[string]bool{"other": true}); acc != nil {
		t.Fatalf("a retry picked %s", acc.ID)
	}
	if storedHealAccount(t, "pick-a").Enabled {
		t.Fatal("a request that already excluded accounts healed")
	}
	acc := h.pickAccount(testKiroPayload(), "claude-sonnet-4.5", nil)
	if acc == nil || acc.ID != "pick-a" {
		t.Fatalf("fresh pick after heal = %v, want pick-a", acc)
	}
	p.RecordSuccess(acc.ID)
	if healer.snapshot().Rounds != 0 {
		t.Fatal("a successful request did not reset the rounds")
	}
}

func TestAccountHealthAPIGetPatchValidateResume(t *testing.T) {
	setupHealTest(t)
	old := healer
	healer = newSelfHealer()
	t.Cleanup(func() { healer = old })
	h := &Handler{}
	events := healEvents(t)

	get := func() accountHealthResponse {
		t.Helper()
		rec := httptest.NewRecorder()
		h.apiGetAccountHealth(rec, httptest.NewRequest(http.MethodGet, "/admin/api/account-health", nil))
		var body accountHealthResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		return body
	}
	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.apiUpdateAccountHealth(rec, httptest.NewRequest(http.MethodPost, "/admin/api/account-health", strings.NewReader(body)))
		return rec
	}

	if got := get(); !got.Enabled || got.MinIntervalSec != 300 || got.MaxRounds != 5 || got.State != (config.SelfHealState{}) {
		t.Fatalf("defaults = %+v", got)
	}
	if rec := post(`{"enabled":false,"minIntervalSec":60,"maxRounds":0}`); rec.Code != http.StatusOK {
		t.Fatalf("patch status %d: %s", rec.Code, rec.Body.String())
	}
	if got := get(); got.Enabled || got.MinIntervalSec != 60 || got.MaxRounds != 0 {
		t.Fatalf("after patch = %+v", got)
	}
	if rec := post(`{"maxRounds":3}`); rec.Code != http.StatusOK {
		t.Fatalf("partial patch status %d", rec.Code)
	}
	if got := get(); got.Enabled || got.MinIntervalSec != 60 || got.MaxRounds != 3 {
		t.Fatalf("a partial patch changed other fields: %+v", got)
	}
	for body, code := range map[string]string{
		`{"minIntervalSec":29}`:             codeSelfHealIntervalRange,
		`{"minIntervalSec":86401}`:          codeSelfHealIntervalRange,
		`{"maxRounds":-1}`:                  codeSelfHealRoundsRange,
		`{"maxRounds":101}`:                 codeSelfHealRoundsRange,
		`{"maxRounds":"5"}`:                 codeInvalidJSON,
		`{"enabled":true,"maxRounds":1000}`: codeSelfHealRoundsRange,
	} {
		rec := post(body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+code+`"`) {
			t.Fatalf("%s: status %d body %s, want 400 %s", body, rec.Code, rec.Body.String(), code)
		}
	}
	if got := get(); got.Enabled || got.MaxRounds != 3 {
		t.Fatalf("a rejected patch was partly applied: %+v", got)
	}

	if err := config.SaveSelfHealState(config.SelfHealState{Rounds: 3, Halted: true, HaltedAt: 5, LastHealAt: 4}); err != nil {
		t.Fatal(err)
	}
	healer = newSelfHealer()
	if got := get(); !got.State.Halted || got.State.Rounds != 3 {
		t.Fatalf("saved halt not reported: %+v", got.State)
	}
	rec := httptest.NewRecorder()
	h.apiResumeAccountHealth(rec, httptest.NewRequest(http.MethodPost, "/admin/api/account-health/resume", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status %d", rec.Code)
	}
	if got := get(); got.State.Halted || got.State.Rounds != 0 || got.State.LastHealAt != 4 {
		t.Fatalf("after resume = %+v", got.State)
	}
	if got := events(); len(got) != 1 || got[0] != "resumed" {
		t.Fatalf("events = %v, want [resumed]", got)
	}
}

func TestRaisingRoundCapLiftsHalt(t *testing.T) {
	setupHealTest(t)
	if err := config.SaveSelfHealState(config.SelfHealState{Rounds: 5, Halted: true}); err != nil {
		t.Fatal(err)
	}
	s := newSelfHealer()
	s.settingsChanged()
	if !s.snapshot().Halted {
		t.Fatal("a halt at the default cap was lifted")
	}
	zero := 0
	if err := config.UpdateSelfHealSettings(nil, nil, &zero); err != nil {
		t.Fatal(err)
	}
	s.settingsChanged()
	if s.snapshot().Halted {
		t.Fatal("removing the round cap kept the halt")
	}
}

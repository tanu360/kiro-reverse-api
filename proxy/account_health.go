package proxy

import (
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
)

// selfHealer lifts the blocks the proxy put on accounts by itself (auth bans,
// error and throttle cooldowns) once no account can serve. A minimum interval
// spaces heals out, and a cap on heals without a successful request in between
// stops a loop that keeps failing until an admin looks.
type selfHealer struct {
	mu     sync.Mutex
	state  config.SelfHealState
	loaded bool
	// armed is true while a success has something to reset, so the request path
	// skips the lock otherwise. It starts true: the saved state is not read yet.
	armed atomic.Bool
	// seq counts heals, so a request that waited on mu sees one finished meanwhile.
	seq atomic.Uint64
	now func() time.Time
}

func newSelfHealer() *selfHealer {
	s := &selfHealer{now: time.Now}
	s.armed.Store(true)
	return s
}

var healer = newSelfHealer()

func init() {
	pool.SetSuccessHook(func(string) { healer.noteSuccess() })
}

// trySelfHeal heals the pool when the guards allow it, and reports whether an
// account may be free now.
func (h *Handler) trySelfHeal() bool {
	return healer.try(h.pool)
}

// planSelfHeal picks what a heal would restore: accounts the proxy banned for
// an auth failure, and accounts in rotation held only by a healable cooldown.
// Kiro suspensions, manual disables, silent accounts, quota cooldowns and
// accounts that could not serve anyway (a dead token, over their usage limit)
// stay as they are. ok is false while some account can still serve.
func planSelfHeal(accounts []config.Account, view pool.HealView, now time.Time) (banned, cooled []string, ok bool) {
	for _, acc := range accounts {
		if acc.Silent || acc.BanStatus != "BANNED" || acc.BanReason != banReasonAuthFailed {
			continue
		}
		if view.Held[acc.ID] || !pool.HealCandidate(acc, now) {
			continue
		}
		banned = append(banned, acc.ID)
	}
	cooled = view.Cooled
	return banned, cooled, !view.Servable && len(banned)+len(cooled) > 0
}

func (s *selfHealer) loadLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	state, err := config.LoadSelfHealState()
	if err != nil {
		logger.Warnf("[SelfHeal] Failed to read saved state: %v", err)
		return
	}
	s.state = state
	if state.Rounds > 0 || state.Halted {
		s.armed.Store(true)
	}
}

func (s *selfHealer) persistLocked() {
	if err := config.SaveSelfHealState(s.state); err != nil {
		logger.Warnf("[SelfHeal] Failed to save state: %v", err)
	}
}

func roundsLabel(maxRounds int) string {
	if maxRounds == 0 {
		return "unlimited"
	}
	return strconv.Itoa(maxRounds)
}

func (s *selfHealer) try(p *pool.AccountPool) bool {
	if p == nil || !config.GetSelfHeal() {
		return false
	}
	seen := s.seq.Load()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seq.Load() != seen {
		return true
	}
	s.loadLocked()

	maxRounds := config.GetSelfHealMaxRounds()
	capReached := maxRounds > 0 && s.state.Rounds >= maxRounds
	if s.state.Halted && capReached {
		return false
	}
	s.liftStaleHaltLocked(maxRounds)
	now := s.now()
	//! A heal time in the future (the clock went back) restarts the interval from now
	//! instead of blocking healing until the clock catches up.
	if s.state.LastHealAt > now.Unix() {
		s.state.LastHealAt = now.Unix()
		s.persistLocked()
	}
	if s.state.LastHealAt > 0 && now.Before(time.Unix(s.state.LastHealAt, 0).Add(config.GetSelfHealInterval())) {
		return false
	}

	//! Cooldowns and token expiry run on the wall clock; s.now only spaces heals out.
	poolNow := time.Now()
	banned, cooled, ok := planSelfHeal(config.GetAccounts(), p.HealView(poolNow), poolNow)
	if !ok {
		return false
	}
	if capReached {
		s.state.Halted = true
		s.state.HaltedAt = now.Unix()
		s.armed.Store(true)
		s.persistLocked()
		logger.Errorf("[SelfHeal] Stopped after %d rounds without a successful request; check the accounts, then resume self-heal in Settings", s.state.Rounds)
		publishEvent(eventAccountHeal, "halted:"+strconv.Itoa(s.state.Rounds))
		return false
	}

	restored, err := config.ReenableBannedAccounts(banned, banReasonAuthFailed)
	if err != nil {
		logger.Warnf("[SelfHeal] Failed to re-enable auth-banned accounts: %v", err)
	}
	uncooled := p.ClearTransient(append(append([]string(nil), restored...), cooled...))
	if len(restored) > 0 {
		p.Reload()
	}
	healed := make(map[string]bool, len(restored)+len(uncooled))
	for _, id := range restored {
		healed[id] = true
	}
	for _, id := range uncooled {
		healed[id] = true
	}
	if len(healed) == 0 {
		return false
	}

	s.state.Rounds++
	s.state.LastHealAt = now.Unix()
	s.state.LastHealed = len(healed)
	s.armed.Store(true)
	s.seq.Add(1)
	s.persistLocked()
	logger.Warnf("[SelfHeal] Round %d/%s: no account could serve; restored %d accounts (%d auth bans, %d cooldowns)",
		s.state.Rounds, roundsLabel(maxRounds), len(healed), len(restored), len(uncooled))
	publishEvent(eventAccountHeal, "healed:"+strconv.Itoa(len(healed)))
	return true
}

// noteSuccess runs after every successful request. A success proves the pool
// works again: the round count restarts and a halt is lifted.
func (s *selfHealer) noteSuccess() {
	if !s.armed.Load() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	s.armed.Store(false)
	if s.state.Rounds == 0 && !s.state.Halted {
		return
	}
	s.state.Rounds = 0
	s.state.Halted = false
	s.state.HaltedAt = 0
	s.persistLocked()
	logger.Infof("[SelfHeal] A request succeeded; heal rounds reset")
	publishEvent(eventAccountHeal, "recovered")
}

// resume is the admin's go-ahead after a halt: rounds restart from zero.
func (s *selfHealer) resume() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	s.state.Rounds = 0
	s.state.Halted = false
	s.state.HaltedAt = 0
	s.persistLocked()
	logger.Infof("[SelfHeal] Resumed by an admin")
	publishEvent(eventAccountHeal, "resumed")
}

// settingsChanged lifts a halt that a raised or removed round cap no longer justifies.
func (s *selfHealer) settingsChanged() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	s.liftStaleHaltLocked(config.GetSelfHealMaxRounds())
}

// liftStaleHaltLocked lifts a halt the round cap no longer justifies. The cap
// can rise outside the settings API too (a config backup restore), so the heal
// path and the state read check it as well.
func (s *selfHealer) liftStaleHaltLocked(maxRounds int) {
	if !s.state.Halted || (maxRounds > 0 && s.state.Rounds >= maxRounds) {
		return
	}
	s.state.Halted = false
	s.state.HaltedAt = 0
	s.persistLocked()
	logger.Infof("[SelfHeal] Round cap is now %s; self-heal resumed", roundsLabel(maxRounds))
	publishEvent(eventAccountHeal, "resumed")
}

func (s *selfHealer) snapshot() config.SelfHealState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	s.liftStaleHaltLocked(config.GetSelfHealMaxRounds())
	return s.state
}

// keepOffForAdmin turns a proxy auth ban into the admin's own disable when an
// admin switches the account off, so self-heal leaves it off. Other bans keep
// their status: self-heal never lifts them.
func keepOffForAdmin(acc *config.Account) {
	if acc.BanStatus == "BANNED" && acc.BanReason == banReasonAuthFailed {
		acc.BanStatus = "DISABLED"
	}
}

// authBanStatusFor is the status an auth ban on the account gets. An account an
// admin already switched off (disabled, with no proxy ban) keeps the admin's
// DISABLED: a BANNED auth ban written over it would let self-heal switch it
// back on. The stored account decides, since the caller's copy can predate
// the admin's change.
func authBanStatusFor(id string) string {
	for _, acc := range config.GetAccounts() {
		if acc.ID != id {
			continue
		}
		if !acc.Enabled && (acc.BanStatus == "" || acc.BanStatus == "ACTIVE" || acc.BanStatus == "DISABLED") {
			return "DISABLED"
		}
		break
	}
	return "BANNED"
}

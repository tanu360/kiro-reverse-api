package config

import (
	"encoding/json"
	"fmt"
	"time"
)

// Self-heal settings. When no account can serve and some of them are blocked
// only by a state the proxy set itself (an auth ban, an error or throttle
// cooldown), the proxy clears those states and lets the accounts serve again.
const (
	DefaultSelfHealIntervalSec = 300
	MinSelfHealIntervalSec     = 30
	MaxSelfHealIntervalSec     = 86400
	DefaultSelfHealMaxRounds   = 5
	MaxSelfHealMaxRounds       = 100
)

// selfHealStateKey holds the healer's runtime state in its own settings row:
// it changes on the request path, and Save() would take a backup snapshot.
const selfHealStateKey = "self_heal_state"

var (
	ErrSelfHealIntervalRange = fmt.Errorf("minIntervalSec must be between %d and %d", MinSelfHealIntervalSec, MaxSelfHealIntervalSec)
	ErrSelfHealRoundsRange   = fmt.Errorf("maxRounds must be between 0 and %d", MaxSelfHealMaxRounds)
)

// GetSelfHeal reports whether the proxy heals accounts it blocked itself. On by default.
func GetSelfHeal() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.SelfHeal == nil {
		return true
	}
	return *cfg.SelfHeal
}

// GetSelfHealIntervalSec is the least time between two heals, in seconds.
func GetSelfHealIntervalSec() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.SelfHealIntervalSec <= 0 {
		return DefaultSelfHealIntervalSec
	}
	return min(max(cfg.SelfHealIntervalSec, MinSelfHealIntervalSec), MaxSelfHealIntervalSec)
}

func GetSelfHealInterval() time.Duration {
	return time.Duration(GetSelfHealIntervalSec()) * time.Second
}

// GetSelfHealMaxRounds is how many heals may follow one another without a
// successful request in between; 0 means no limit.
func GetSelfHealMaxRounds() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.SelfHealMaxRounds == nil {
		return DefaultSelfHealMaxRounds
	}
	return min(max(*cfg.SelfHealMaxRounds, 0), MaxSelfHealMaxRounds)
}

// UpdateSelfHealSettings validates every given value first, then saves them in
// one write. A nil value keeps the current setting.
func UpdateSelfHealSettings(enabled *bool, intervalSec, maxRounds *int) error {
	if intervalSec != nil && (*intervalSec < MinSelfHealIntervalSec || *intervalSec > MaxSelfHealIntervalSec) {
		return ErrSelfHealIntervalRange
	}
	if maxRounds != nil && (*maxRounds < 0 || *maxRounds > MaxSelfHealMaxRounds) {
		return ErrSelfHealRoundsRange
	}
	if enabled == nil && intervalSec == nil && maxRounds == nil {
		return nil
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if enabled != nil {
		v := *enabled
		cfg.SelfHeal = &v
	}
	if intervalSec != nil {
		cfg.SelfHealIntervalSec = *intervalSec
	}
	if maxRounds != nil {
		v := *maxRounds
		cfg.SelfHealMaxRounds = &v
	}
	return Save()
}

// SelfHealState is the healer's runtime state, kept across restarts.
type SelfHealState struct {
	// LastHealAt is the unix time of the last heal; the interval counts from it.
	LastHealAt int64 `json:"lastHealAt"`
	// Rounds counts heals since the last successful request.
	Rounds int `json:"rounds"`
	// Halted is set once Rounds reached the cap; healing waits for a success or a resume.
	Halted   bool  `json:"halted"`
	HaltedAt int64 `json:"haltedAt"`
	// LastHealed is how many accounts the last heal restored.
	LastHealed int `json:"lastHealed"`
}

// LoadSelfHealState reads the saved state; a missing row is the zero state.
func LoadSelfHealState() (SelfHealState, error) {
	var state SelfHealState
	raw, ok, err := getSetting(selfHealStateKey)
	if err != nil || !ok {
		return state, err
	}
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return SelfHealState{}, err
	}
	return state, nil
}

func SaveSelfHealState(state SelfHealState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return setSetting(selfHealStateKey, string(data))
}

// ReenableBannedAccounts puts back into rotation each of ids that is still
// banned with banReason, and returns the ids it changed. The ban is checked
// again under the lock, so an account an admin changed meanwhile stays as the
// admin left it. All rows are saved in one write.
func ReenableBannedAccounts(ids []string, banReason string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	reenable := func(acc *Account) bool {
		if !want[acc.ID] || acc.Silent || acc.BanStatus != "BANNED" || acc.BanReason != banReason {
			return false
		}
		acc.Enabled = true
		acc.BanStatus = "ACTIVE"
		acc.BanReason = ""
		acc.BanTime = 0
		return true
	}

	var changed []string
	var err error
	if CredentialsLoaded() {
		changed, err = reenableCredentials(reenable)
	} else {
		changed, err = reenableConfigAccounts(reenable)
	}
	if err != nil {
		return nil, err
	}
	for _, id := range changed {
		notifyAccountsChanged(id)
	}
	return changed, nil
}

func reenableConfigAccounts(reenable func(*Account) bool) ([]string, error) {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	var changed []string
	for i := range cfg.Accounts {
		if reenable(&cfg.Accounts[i]) {
			changed = append(changed, cfg.Accounts[i].ID)
		}
	}
	if len(changed) == 0 {
		return nil, nil
	}
	if err := Save(); err != nil {
		return nil, err
	}
	return changed, nil
}

func reenableCredentials(reenable func(*Account) bool) ([]string, error) {
	credLock.Lock()
	defer credLock.Unlock()
	var changed []string
	for i := range credentials {
		if reenable(&credentials[i]) {
			changed = append(changed, credentials[i].ID)
		}
	}
	if len(changed) == 0 {
		return nil, nil
	}
	if err := saveCredentialsLocked(); err != nil {
		return nil, err
	}
	return changed, nil
}

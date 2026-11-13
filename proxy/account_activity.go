package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

// codeAccountRPMLimitRange rejects an accountRpmLimit outside 0..MaxAccountRPMLimit.
const codeAccountRPMLimitRange = "account_rpm_limit_range"

// accountRateSlots is the live RPM window in seconds, one ring slot each.
const accountRateSlots = 60

// rateSlot counts the final requests one account finished in one second.
type rateSlot struct {
	sec int64
	n   int
}

// accountRateTracker counts each account's final client requests per second
// over the last minute, for the live RPM on the Accounts page. The observe
// store's minute rings cannot answer a sliding 60 s window.
type accountRateTracker struct {
	mu    sync.Mutex
	rings map[string]*[accountRateSlots]rateSlot
}

// accountRates is fed by RecordTracedRequestWithCache, on the same final
// account the minute rings count, so a retried request counts once.
var accountRates = &accountRateTracker{}

func (t *accountRateTracker) record(accountID string, tsUnix int64) {
	if accountID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.rings == nil {
		t.rings = make(map[string]*[accountRateSlots]rateSlot)
	}
	ring := t.rings[accountID]
	if ring == nil {
		ring = &[accountRateSlots]rateSlot{}
		t.rings[accountID] = ring
	}
	slot := &ring[rateSlotIndex(tsUnix)]
	if slot.sec != tsUnix {
		*slot = rateSlot{sec: tsUnix}
	}
	slot.n++
}

// count returns the account's requests finished in (nowUnix-60, nowUnix].
func (t *accountRateTracker) count(accountID string, nowUnix int64) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return countRateRing(t.rings[accountID], nowUnix)
}

// snapshot returns every account's live RPM and drops the rings that hold
// nothing in the window any more, so idle and deleted accounts free their ring.
func (t *accountRateTracker) snapshot(nowUnix int64) map[string]int {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]int, len(t.rings))
	for id, ring := range t.rings {
		n := countRateRing(ring, nowUnix)
		if n == 0 {
			delete(t.rings, id)
			continue
		}
		out[id] = n
	}
	return out
}

// move adds the live RPM of removed accounts to the kept one, for a duplicate
// merge. A slot holds one second at a time, so the newer second wins.
func (t *accountRateTracker) move(keepID string, removed []string) {
	if keepID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, id := range removed {
		src := t.rings[id]
		if src == nil || id == keepID {
			continue
		}
		delete(t.rings, id)
		dst := t.rings[keepID]
		if dst == nil {
			t.rings[keepID] = src
			continue
		}
		for i := range src {
			switch s, d := &src[i], &dst[i]; {
			case s.sec > d.sec:
				*d = *s
			case s.sec == d.sec && s.sec != 0:
				d.n += s.n
			}
		}
	}
}

func (t *accountRateTracker) reset() {
	t.mu.Lock()
	t.rings = nil
	t.mu.Unlock()
}

func rateSlotIndex(sec int64) int {
	return int(((sec % accountRateSlots) + accountRateSlots) % accountRateSlots)
}

func countRateRing(ring *[accountRateSlots]rateSlot, nowUnix int64) int {
	if ring == nil {
		return 0
	}
	total := 0
	for i := range ring {
		//! A slot from after now (the clock stepped back) is not in the window.
		if s := ring[i]; s.sec > nowUnix-accountRateSlots && s.sec <= nowUnix {
			total += s.n
		}
	}
	return total
}

// activityLocation is the time zone "today" is a calendar day in: the
// server's. Tests pin it.
var activityLocation = func() *time.Location { return time.Local }

// localDayStart is the midnight that began now's calendar day.
func localDayStart(now time.Time) time.Time {
	t := now.In(activityLocation())
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// accountToday sums each account's final requests from dayStartMin through
// curMin (both unix minutes) out of the minute rings. The rings hold one day,
// so a 25-hour day loses its first hour. Accounts without requests are left out.
func (s *observeStore) accountToday(dayStartMin, curMin int64) map[string]int {
	if s == nil {
		return nil
	}
	lo := max(dayStartMin, curMin-observeMinuteSlots+1)
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int, len(s.accountRings))
	for id, ring := range s.accountRings {
		total := 0
		for i := range ring {
			//! The window match also skips slots from after now (a clock step back).
			if b := &ring[i]; b.WindowMin >= lo && b.WindowMin <= curMin {
				total += b.Reqs
			}
		}
		if total > 0 {
			out[id] = total
		}
	}
	return out
}

// accountActivity is one account's line on the Accounts page.
type accountActivity struct {
	// Today counts final client requests, success or failure, since local midnight.
	Today int `json:"today"`
	// RPM counts final client requests finished in the last 60 seconds.
	RPM int `json:"rpm"`
	// AtLimit: the account started RPMLimit requests in the last minute and is skipped.
	AtLimit bool `json:"atLimit"`
	// CooldownUntil (unix s) is set while the pool skips the account after errors or a 429;
	// the Accounts page showed such an account as plain Active while its bound key got 503.
	CooldownUntil int64 `json:"cooldownUntil,omitempty"`
}

type accountActivityResponse struct {
	NowUnix      int64 `json:"nowUnix"`
	DayStartUnix int64 `json:"dayStartUnix"`
	// RPMLimit is the per-account limit; 0 means off.
	RPMLimit int                        `json:"rpmLimit"`
	Accounts map[string]accountActivity `json:"accounts"`
}

// buildAccountActivity gives every configured account its numbers, zeros when
// idle. Ids that are not configured (a deleted account) are left out.
func buildAccountActivity(store *observeStore, p *accountpool.AccountPool, accounts []config.Account, now time.Time) accountActivityResponse {
	nowUnix := now.Unix()
	dayStart := localDayStart(now)
	_, curMin := curSlot(nowUnix)
	today := store.accountToday(floorDiv(dayStart.Unix(), 60), curMin)
	rates := accountRates.snapshot(nowUnix)
	var atLimit map[string]bool
	if p != nil {
		atLimit = p.AtRPMLimit()
	}
	out := accountActivityResponse{
		NowUnix:      nowUnix,
		DayStartUnix: dayStart.Unix(),
		RPMLimit:     config.GetAccountRPMLimit(),
		Accounts:     make(map[string]accountActivity, len(accounts)),
	}
	for _, a := range accounts {
		activity := accountActivity{Today: today[a.ID], RPM: rates[a.ID], AtLimit: atLimit[a.ID]}
		if p != nil {
			if until := p.CooldownUntil(a.ID); until.After(now) {
				activity.CooldownUntil = until.Unix()
			}
		}
		out.Accounts[a.ID] = activity
	}
	return out
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// apiAccountActivity serves GET /admin/api/observe/account-activity: each
// account's requests today and live RPM, light enough to poll every few seconds.
func (h *Handler) apiAccountActivity(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(buildAccountActivity(getObserveStore(), h.pool, config.GetAccounts(), observeNow()))
}

// validAccountRPMLimit writes a 400 and returns false when a settings patch
// carries an accountRpmLimit out of range. A nil value is valid: not patched.
func validAccountRPMLimit(w http.ResponseWriter, v *int) bool {
	if v == nil || (*v >= 0 && *v <= config.MaxAccountRPMLimit) {
		return true
	}
	writeAdminError(w, http.StatusBadRequest, codeAccountRPMLimitRange, fmt.Sprintf("accountRpmLimit must be between 0 and %d", config.MaxAccountRPMLimit))
	return false
}

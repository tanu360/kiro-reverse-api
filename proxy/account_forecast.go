package proxy

import (
	"database/sql"
	"encoding/json"
	"maps"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// Credit depletion forecast: from what each account spent recently, when its
// credits run out at that rate, and whether that comes before they reset.

const (
	// forecastWindowDays is how far back the spend rate looks.
	forecastWindowDays = 7
	// forecastMinSpanDays is the shortest span the rate averages over, so an
	// account first used an hour ago is not extrapolated from that hour.
	forecastMinSpanDays = 1
)

// Forecast states.
const (
	// forecastUnknown: no credit limit or reset date is known (never refreshed).
	forecastUnknown = "unknown"
	// forecastEmpty: no credits left.
	forecastEmpty = "empty"
	// forecastIdle: nothing spent in the window, so every credit left is still there at the reset.
	forecastIdle = "idle"
	// forecastLasts: at the current rate the credits last until they reset.
	forecastLasts = "lasts"
	// forecastRunsOut: at the current rate the credits run out before they reset.
	forecastRunsOut = "runs_out"
)

// accountForecast is one account's forecast.
type accountForecast struct {
	Status string `json:"status"`
	// Spent is the credits the account spent in the window.
	Spent float64 `json:"spent"`
	// SpanDays is the days Spent averages over: the window, or less for an
	// account first used inside it, but never under a day.
	SpanDays float64 `json:"spanDays"`
	// BurnPerDay is Spent / SpanDays.
	BurnPerDay float64 `json:"burnPerDay"`
	// Remaining is the credits left now, counting what was spent since the last
	// usage refresh; 0 when the limit is unknown.
	Remaining float64 `json:"remaining"`
	// ResetAt is when the credits reset (unix s): Kiro's exact moment, else the
	// start of the reset day in the server's time zone; 0 when unknown.
	ResetAt int64 `json:"resetAt,omitempty"`
	// DepletesAt is when the credits run out at BurnPerDay (unix s); 0 when
	// nothing is spent or the credits are already gone.
	DepletesAt int64 `json:"depletesAt,omitempty"`
	// LeftAtReset is the credits expected to be unused when they reset.
	LeftAtReset float64 `json:"leftAtReset"`
}

type accountForecastResponse struct {
	NowUnix    int64                      `json:"nowUnix"`
	WindowDays int                        `json:"windowDays"`
	Forecasts  map[string]accountForecast `json:"forecasts"`
}

// accountSpend is one account's credits in the window and the first moment it
// spent any of them there.
type accountSpend struct {
	credits float64
	firstTS int64
}

// loadAccountSpend sums each account's credits since its moment in from: the
// request log, plus the daily rollup of rows log retention already pruned
// (whole UTC days, counted from the day that holds the moment). Accounts not in
// from are left out. maxRequestID is the newest request row in the snapshot the
// sums read.
func loadAccountSpend(from map[string]int64) (map[string]accountSpend, int64, error) {
	out := make(map[string]accountSpend)
	d, err := db.Read()
	if err != nil {
		return out, 0, err
	}
	tx, err := d.Begin()
	if err != nil {
		return out, 0, err
	}
	defer tx.Rollback()
	var maxRequestID int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM requests`).Scan(&maxRequestID); err != nil {
		return out, 0, err
	}
	if len(from) == 0 {
		return out, maxRequestID, nil
	}
	//! One scan serves every account's own moment: a row's bucket is how many of
	//! the distinct moments it is at or after, so the account whose moment is the
	//! j-th earliest (from 0) keeps the buckets above j.
	moments := slices.Compact(slices.Sorted(maps.Values(from)))
	bucket := func(col string) string {
		return strings.TrimSuffix(strings.Repeat("("+col+" >= ?) + ", len(moments)), " + ")
	}
	tsArgs := make([]any, 0, len(moments)+1)
	dayArgs := make([]any, 0, len(moments)+1)
	for _, m := range moments {
		tsArgs = append(tsArgs, m)
		dayArgs = append(dayArgs, floorDiv(m, daySeconds))
	}
	tsArgs = append(tsArgs, moments[0])
	dayArgs = append(dayArgs, floorDiv(moments[0], daySeconds))
	keep := func(id string, b int) bool {
		m, ok := from[id]
		if !ok {
			return false
		}
		j, _ := slices.BinarySearch(moments, m)
		return b > j
	}
	add := func(id string, credits float64, first int64) {
		cur, ok := out[id]
		cur.credits += credits
		if !ok || first < cur.firstTS {
			cur.firstTS = first
		}
		out[id] = cur
	}
	rows, err := tx.Query(`SELECT account_id, `+bucket("ts")+` AS b, COALESCE(SUM(credits), 0), MIN(ts) FROM requests
WHERE ts >= ? AND account_id <> '' GROUP BY account_id, b`, tsArgs...)
	if err != nil {
		return out, maxRequestID, err
	}
	for rows.Next() {
		var id string
		var b int
		var credits float64
		var first int64
		if err := rows.Scan(&id, &b, &credits, &first); err != nil {
			rows.Close()
			return out, maxRequestID, err
		}
		if keep(id, b) {
			add(id, credits, first)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, maxRequestID, err
	}
	rows, err = tx.Query(`SELECT account_id, `+bucket("day")+` AS b, COALESCE(SUM(credits), 0), MIN(day) FROM request_rollup_daily
WHERE day >= ? AND account_id <> '' GROUP BY account_id, b`, dayArgs...)
	if err != nil {
		return out, maxRequestID, err
	}
	for rows.Next() {
		var id string
		var b int
		var credits float64
		var day int64
		if err := rows.Scan(&id, &b, &credits, &day); err != nil {
			rows.Close()
			return out, maxRequestID, err
		}
		if keep(id, b) {
			add(id, credits, max(day*daySeconds, from[id]))
		}
	}
	rows.Close()
	return out, maxRequestID, rows.Err()
}

// resetMoment is when acc's credits reset: the exact moment Kiro gave, else
// the start of its reset day in the server's time zone (NextResetDate is
// written in it), or 0 when it has neither.
func resetMoment(acc config.Account) int64 {
	if acc.NextResetAt > 0 {
		return acc.NextResetAt
	}
	if acc.NextResetDate == "" {
		return 0
	}
	t, err := time.ParseInLocation("2006-01-02", acc.NextResetDate, time.Local)
	if err != nil {
		return 0
	}
	return t.Unix()
}

// cycleStart is when acc's current billing cycle began: one calendar month
// before its reset moment, or the start of now's calendar month in the server's
// time zone when the reset moment is unknown (never refreshed).
func cycleStart(acc config.Account, now time.Time) int64 {
	if reset := resetMoment(acc); reset > 0 {
		return time.Unix(reset, 0).AddDate(0, -1, 0).Unix()
	}
	now = now.Local()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.Local).Unix()
}

// cycleCreditsCache keeps each account's credits since its cycle start for
// /status, the way requestStatsCache keeps the all-time totals: it adds only the
// rows logged since, and sums everything again after requestLogChanged, on a new
// database handle, when a cycle start moves, and once a minute regardless.
var cycleCreditsCache struct {
	mu sync.Mutex
	//! Holding the handle keeps it from being freed, so a new handle never reuses its address.
	db           *sql.DB
	gen          uint64
	at           time.Time
	starts       map[string]int64
	maxRequestID int64
	credits      map[string]float64
}

// proxyCycleCredits is the credits the proxy logged for each account in its
// current billing cycle, each capped at the account's UsageCurrent (the plan use
// the Overview splits), summed.
func proxyCycleCredits(accounts []config.Account, now time.Time) (float64, error) {
	starts := make(map[string]int64, len(accounts))
	for _, acc := range accounts {
		starts[acc.ID] = cycleStart(acc, now)
	}
	d, err := db.Read()
	if err != nil {
		return 0, err
	}
	c := &cycleCreditsCache
	c.mu.Lock()
	defer c.mu.Unlock()
	//! Read before the sums: a change committed while they run moves it on, and the next call sums again.
	gen := requestLogGen.Load()
	if c.db == d && c.gen == gen && maps.Equal(c.starts, starts) && time.Since(c.at) < requestStatsMaxAge {
		// The rows logged since: few, so each is checked against its account's start here.
		rows, err := d.Query(`SELECT id, ts, account_id, credits FROM requests WHERE id > ?`, c.maxRequestID)
		if err != nil {
			return 0, err
		}
		for rows.Next() {
			var id, ts int64
			var accountID string
			var credits float64
			if err := rows.Scan(&id, &ts, &accountID, &credits); err != nil {
				rows.Close()
				return 0, err
			}
			if start, ok := starts[accountID]; ok && ts >= start {
				c.credits[accountID] += credits
			}
			c.maxRequestID = max(c.maxRequestID, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}
	} else {
		spend, maxRequestID, err := loadAccountSpend(starts)
		if err != nil {
			c.db = nil
			return 0, err
		}
		c.credits = make(map[string]float64, len(spend))
		for id, s := range spend {
			c.credits[id] = s.credits
		}
		c.db, c.gen, c.at, c.starts, c.maxRequestID = d, gen, time.Now(), starts, maxRequestID
	}
	var sum float64
	for _, acc := range accounts {
		sum += min(c.credits[acc.ID], acc.UsageCurrent)
	}
	return sum, nil
}

// forecastAccount is acc's forecast at now from its spend in the window.
// spentSinceRefresh is what it spent since its usage was last refreshed.
func forecastAccount(acc config.Account, spend accountSpend, spentSinceRefresh float64, now time.Time) accountForecast {
	nowUnix := now.Unix()
	from := nowUnix - forecastWindowDays*daySeconds
	f := accountForecast{Status: forecastUnknown, Spent: spend.credits}
	start := from
	if spend.credits > 0 && spend.firstTS > start {
		start = spend.firstTS
	}
	f.SpanDays = math.Max(float64(nowUnix-start)/float64(daySeconds), forecastMinSpanDays)
	f.BurnPerDay = f.Spent / f.SpanDays
	f.ResetAt = resetMoment(acc)
	if acc.UsageLimit <= 0 {
		return f
	}
	f.Remaining = math.Max(acc.UsageLimit-acc.UsageCurrent-spentSinceRefresh, 0)
	switch {
	case f.Remaining <= 0:
		f.Status = forecastEmpty
		return f
	case f.ResetAt <= nowUnix:
		//! A reset date that has passed is a refresh that has not caught up yet: nothing to compare with.
		f.ResetAt = 0
		if f.BurnPerDay > 0 {
			f.DepletesAt = nowUnix + int64(f.Remaining/f.BurnPerDay*float64(daySeconds))
		}
		return f
	case f.BurnPerDay <= 0:
		f.Status = forecastIdle
		f.LeftAtReset = f.Remaining
		return f
	}
	f.DepletesAt = nowUnix + int64(f.Remaining/f.BurnPerDay*float64(daySeconds))
	if f.DepletesAt < f.ResetAt {
		f.Status = forecastRunsOut
		return f
	}
	f.Status = forecastLasts
	f.LeftAtReset = math.Max(f.Remaining-f.BurnPerDay*float64(f.ResetAt-nowUnix)/float64(daySeconds), 0)
	return f
}

// accountForecasts is the forecast of every account at now.
func (h *Handler) accountForecasts(accounts []config.Account, now time.Time) (map[string]accountForecast, error) {
	from := now.Unix() - forecastWindowDays*daySeconds
	starts := make(map[string]int64, len(accounts))
	for _, acc := range accounts {
		starts[acc.ID] = from
	}
	spend, _, err := loadAccountSpend(starts)
	out := make(map[string]accountForecast, len(accounts))
	for _, acc := range accounts {
		var local float64
		if h.pool != nil {
			local = h.pool.SpentSinceRefresh(acc.ID)
		}
		out[acc.ID] = forecastAccount(acc, spend[acc.ID], local, now)
	}
	return out, err
}

// apiAccountForecast serves GET /admin/api/accounts/forecast.
func (h *Handler) apiAccountForecast(w http.ResponseWriter, _ *http.Request) {
	now := observeNow()
	forecasts, err := h.accountForecasts(config.GetAccounts(), now)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, codeInternalError)
		return
	}
	json.NewEncoder(w).Encode(accountForecastResponse{
		NowUnix:    now.Unix(),
		WindowDays: forecastWindowDays,
		Forecasts:  forecasts,
	})
}

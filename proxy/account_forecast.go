package proxy

import (
	"encoding/json"
	"math"
	"net/http"
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

// loadAccountSpend sums each account's credits since from: the request log,
// plus the daily rollup of rows log retention already pruned (whole UTC days,
// counted from the day that holds from).
func loadAccountSpend(from int64) (map[string]accountSpend, error) {
	out := make(map[string]accountSpend)
	d, err := db.Get()
	if err != nil {
		return out, err
	}
	tx, err := d.Begin()
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	add := func(id string, credits float64, first int64) {
		cur, ok := out[id]
		cur.credits += credits
		if !ok || first < cur.firstTS {
			cur.firstTS = first
		}
		out[id] = cur
	}
	rows, err := tx.Query(`SELECT account_id, COALESCE(SUM(credits), 0), MIN(ts) FROM requests
WHERE ts >= ? AND account_id <> '' GROUP BY account_id`, from)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		var credits float64
		var first int64
		if err := rows.Scan(&id, &credits, &first); err != nil {
			rows.Close()
			return out, err
		}
		add(id, credits, first)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = tx.Query(`SELECT account_id, COALESCE(SUM(credits), 0), MIN(day) FROM request_rollup_daily
WHERE day >= ? AND account_id <> '' GROUP BY account_id`, floorDiv(from, daySeconds))
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		var credits float64
		var day int64
		if err := rows.Scan(&id, &credits, &day); err != nil {
			rows.Close()
			return out, err
		}
		add(id, credits, max(day*daySeconds, from))
	}
	rows.Close()
	return out, rows.Err()
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
	spend, err := loadAccountSpend(now.Unix() - forecastWindowDays*daySeconds)
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
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	json.NewEncoder(w).Encode(accountForecastResponse{
		NowUnix:    now.Unix(),
		WindowDays: forecastWindowDays,
		Forecasts:  forecasts,
	})
}

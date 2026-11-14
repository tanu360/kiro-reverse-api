package proxy

import (
	"encoding/json"
	"net/http"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// All-time charts: Usage by key's "all" range and the Overview traffic card's "all" range. Both
// read every row the request and error logs still keep, the rows log retention pruned from
// request_rollup_daily and error_rollup_daily by their UTC day, and the rows it pruned before it
// kept daily totals from request_rollup and error_rollup minus the daily tables. That last part
// has no day, so it counts in the totals and in "earlier", never in a bucket.
//
// Buckets are local days, Monday weeks, months or years, the smallest that keeps the chart at
// maxLifetimeBuckets bars from the oldest row to today. A pruned row's UTC date stands for its
// local date: the daily tables keep no time of day.

const (
	daySeconds         = int64(86400)
	maxLifetimeBuckets = 60
	// minLifetimeDays: a young log still draws a week of days, not one wide bar.
	minLifetimeDays = 7
)

// localDay is the viewer's day number of ts: days since 1970-01-01 at offset off seconds.
func localDay(ts, off int64) int64 {
	return floorDiv(ts+off, daySeconds)
}

// weekStart is the Monday on or before day. Day 0, 1970-01-01, was a Thursday.
func weekStart(day int64) int64 {
	return day - (day + 3 - 7*floorDiv(day+3, 7))
}

func dayDate(day int64) time.Time {
	return time.Unix(day*daySeconds, 0).UTC()
}

// monthNumber counts months from year 0, so two months subtract to the months between them.
func monthNumber(day int64) int64 {
	t := dayDate(day)
	return int64(t.Year())*12 + int64(t.Month()) - 1
}

func dateDay(year int, month time.Month) int64 {
	return floorDiv(time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).Unix(), daySeconds)
}

// lifetimeLayout is the bucket grid of an all-time chart, in local day numbers.
type lifetimeLayout struct {
	bucket    string
	bucketSec int64
	// starts[i] is the first day of bucket i; end is the day after the last bucket.
	starts []int64
	end    int64
}

// newLifetimeLayout lays buckets from the bucket that holds firstDay to the one that holds
// today (curDay), the current one partial.
func newLifetimeLayout(firstDay, curDay int64) lifetimeLayout {
	if firstDay > curDay-(minLifetimeDays-1) {
		firstDay = curDay - (minLifetimeDays - 1)
	}
	var l lifetimeLayout
	switch {
	case curDay-firstDay+1 <= maxLifetimeBuckets:
		l.bucket, l.bucketSec = "day", daySeconds
		for d := firstDay; d <= curDay; d++ {
			l.starts = append(l.starts, d)
		}
		l.end = curDay + 1
	case (weekStart(curDay)-weekStart(firstDay))/7+1 <= maxLifetimeBuckets:
		l.bucket, l.bucketSec = "week", 7*daySeconds
		for d := weekStart(firstDay); d <= curDay; d += 7 {
			l.starts = append(l.starts, d)
		}
		l.end = weekStart(curDay) + 7
	case monthNumber(curDay)-monthNumber(firstDay)+1 <= maxLifetimeBuckets:
		l.bucket = "month"
		for m := monthNumber(firstDay); m <= monthNumber(curDay); m++ {
			l.starts = append(l.starts, dateDay(int(m/12), time.Month(m%12+1)))
		}
		next := monthNumber(curDay) + 1
		l.end = dateDay(int(next/12), time.Month(next%12+1))
	default:
		l.bucket = "year"
		for y := dayDate(firstDay).Year(); y <= dayDate(curDay).Year(); y++ {
			l.starts = append(l.starts, dateDay(y, time.January))
		}
		l.end = dateDay(dayDate(curDay).Year()+1, time.January)
	}
	return l
}

// index is the bucket that holds day, or -1 outside the grid.
func (l lifetimeLayout) index(day int64) int {
	if len(l.starts) == 0 || day < l.starts[0] || day >= l.end {
		return -1
	}
	var i int64
	switch l.bucket {
	case "day":
		i = day - l.starts[0]
	case "week":
		i = (weekStart(day) - l.starts[0]) / 7
	case "month":
		i = monthNumber(day) - monthNumber(l.starts[0])
	default:
		i = int64(dayDate(day).Year() - dayDate(l.starts[0]).Year())
	}
	if i < 0 || i >= int64(len(l.starts)) {
		return -1
	}
	return int(i)
}

// unixStarts are the bucket starts as unix seconds: the viewer's local midnights.
func (l lifetimeLayout) unixStarts(off int64) []int64 {
	out := make([]int64, len(l.starts))
	for i, d := range l.starts {
		out[i] = d*daySeconds - off
	}
	return out
}

// scanRollupUsageDays reads request_rollup_daily per UTC day in [fromDay, toDay] (all days when
// toDay < fromDay), API key ID and keyless flag.
func scanRollupUsageDays(q usageQueryer, fromDay, toDay int64, fn func(day int64, keyID string, keyless bool, t apiKeyUsageTotals)) error {
	where := ""
	var args []interface{}
	if toDay >= fromDay {
		where = "WHERE day >= ? AND day <= ?"
		args = append(args, fromDay, toDay)
	}
	rows, err := q.Query(`SELECT day, api_key_id, keyless,
COALESCE(SUM(request_count), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN request_count ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM request_rollup_daily `+where+`
GROUP BY day, api_key_id, keyless`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			day     int64
			keyID   string
			keyless bool
			t       apiKeyUsageTotals
		)
		if err := rows.Scan(&day, &keyID, &keyless, &t.Requests, &t.Succeeded, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
			return err
		}
		fn(day, keyID, keyless, t)
	}
	return rows.Err()
}

// undatedRequestsSQL sums, per API key ID and outcome, what request_rollup holds beyond
// request_rollup_daily: the rows pruned before daily totals were kept. Each group counts only
// what it holds beyond its daily rows, never less than nothing.
const undatedRequestsSQL = `SELECT r.api_key_id, r.success,
COALESCE(SUM(CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.request_count - COALESCE(d.n, 0) ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.in_tokens - COALESCE(d.i, 0) ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.out_tokens - COALESCE(d.o, 0) ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN r.request_count > COALESCE(d.n, 0) THEN r.credits - COALESCE(d.c, 0) ELSE 0 END), 0)
FROM request_rollup r LEFT JOIN (
SELECT model, account_id, api_key_id, success, SUM(request_count) AS n, SUM(in_tokens) AS i, SUM(out_tokens) AS o, SUM(credits) AS c
FROM request_rollup_daily GROUP BY model, account_id, api_key_id, success
) d ON d.model = r.model AND d.account_id = r.account_id AND d.api_key_id = r.api_key_id AND d.success = r.success
GROUP BY r.api_key_id, r.success`

// undatedErrorsSQL is undatedRequestsSQL for error_rollup: failed attempts with no day.
const undatedErrorsSQL = `SELECT COALESCE(SUM(CASE WHEN r.error_count > COALESCE(d.n, 0) THEN r.error_count - COALESCE(d.n, 0) ELSE 0 END), 0)
FROM error_rollup r LEFT JOIN (
SELECT model, account_id, SUM(error_count) AS n FROM error_rollup_daily GROUP BY model, account_id
) d ON d.model = r.model AND d.account_id = r.account_id`

// usageDayRow is one day of one key's usage before the grid is known.
type usageDayRow struct {
	day   int64
	keyID string
	slot  int
	t     apiKeyUsageTotals
}

// queryApiKeyUsageAllTime is queryApiKeyUsage over every logged request: the request log by the
// viewer's local day, the pruned rows by their UTC day, and the pruned rows without a day as
// earlier traffic. Totals per key equal the request log plus request_rollup, so they match the
// lifetime totals elsewhere.
func queryApiKeyUsageAllTime(now time.Time, tzOffsetMin int, keys []config.ApiKeyEntry) (apiKeyUsageResponse, error) {
	off := int64(tzOffsetMin) * 60
	curDay := localDay(now.Unix(), off)
	resp := apiKeyUsageResponse{
		Range:    usageRangeAll,
		TZOffset: tzOffsetMin,
		NowUnix:  now.Unix(),
		Keys:     []apiKeyUsageEntry{},
	}

	d, err := db.Get()
	if err != nil {
		return resp, err
	}
	//! One transaction: a prune between the reads would count a row twice or miss it.
	tx, err := d.Begin()
	if err != nil {
		return resp, err
	}
	defer tx.Rollback()

	var dated []usageDayRow
	firstDay := curDay
	note := func(row usageDayRow) {
		dated = append(dated, row)
		if row.day < firstDay {
			firstDay = row.day
		}
	}

	slot, slotArgs := usageSlotSQL(keys)
	args := append([]interface{}{off, daySeconds}, slotArgs...)
	rows, err := tx.Query(`SELECT
(ts + ?) / ? AS b,
api_key_id,
`+slot+` AS slot,
COUNT(*),
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0),
COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(credits), 0)
FROM requests
GROUP BY b, api_key_id, slot`, args...)
	if err != nil {
		return resp, err
	}
	for rows.Next() {
		var row usageDayRow
		if err := rows.Scan(&row.day, &row.keyID, &row.slot, &row.t.Requests, &row.t.Succeeded, &row.t.InTokens, &row.t.OutTokens, &row.t.Credits); err != nil {
			rows.Close()
			return resp, err
		}
		note(row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return resp, err
	}
	if err := scanRollupUsageDays(tx, 0, -1, func(day int64, keyID string, keyless bool, t apiKeyUsageTotals) {
		note(usageDayRow{day: day, keyID: keyID, slot: rollupUsageSlot(keyID, keyless), t: t})
	}); err != nil {
		return resp, err
	}

	layout := newLifetimeLayout(firstDay, curDay)
	resp.Bucket = layout.bucket
	resp.BucketSeconds = layout.bucketSec
	resp.Buckets = layout.unixStarts(off)
	resp.From = layout.starts[0]*daySeconds - off
	resp.To = layout.end*daySeconds - off

	c := newUsageCollector(keys, len(layout.starts))
	for _, row := range dated {
		//! A row dated after the current bucket (a clock that ran ahead) is left out, as the
		//! other ranges leave out rows after their end.
		if idx := layout.index(row.day); idx >= 0 {
			c.add(c.entry(row.keyID, row.slot), idx, row.t)
		}
	}

	//! request_rollup kept no key value, so a pruned row without a key ID cannot tell an invalid
	//! key from none; it counts under no key.
	urows, err := tx.Query(undatedRequestsSQL)
	if err != nil {
		return resp, err
	}
	for urows.Next() {
		var (
			keyID   string
			success bool
			t       apiKeyUsageTotals
		)
		if err := urows.Scan(&keyID, &success, &t.Requests, &t.InTokens, &t.OutTokens, &t.Credits); err != nil {
			urows.Close()
			return resp, err
		}
		if t.Requests <= 0 {
			continue
		}
		if success {
			t.Succeeded = t.Requests
		}
		slot := usageSlotNoKey
		if keyID != "" {
			slot = usageSlotByID
		}
		c.add(c.entry(keyID, slot), -1, t)
	}
	urows.Close()
	if err := urows.Err(); err != nil {
		return resp, err
	}

	if err := c.finish(tx, &resp); err != nil {
		return resp, err
	}
	return resp, nil
}

// trafficCounts is one bucket of the Overview traffic chart: final requests by outcome, and the
// failed upstream attempts the proxy retried (the errors log).
type trafficCounts struct {
	Succeeded int64 `json:"succeeded"`
	Failed    int64 `json:"failed"`
	Retried   int64 `json:"retried"`
}

func (c *trafficCounts) add(o trafficCounts) {
	c.Succeeded += o.Succeeded
	c.Failed += o.Failed
	c.Retried += o.Retried
}

type trafficHistoryResponse struct {
	Range         string `json:"range"`
	Bucket        string `json:"bucket"`
	BucketSeconds int64  `json:"bucketSeconds"`
	TZOffset      int    `json:"tzOffset"`
	From          int64  `json:"from"`
	To            int64  `json:"to"`
	NowUnix       int64  `json:"nowUnix"`
	// Bucket starts, unix seconds, oldest first; Series has one value per bucket.
	Buckets []int64         `json:"buckets"`
	Series  []trafficCounts `json:"series"`
	// Totals is every bucket plus Earlier.
	Totals trafficCounts `json:"totals"`
	// Earlier is the traffic log retention pruned before it kept daily totals: it has no day.
	Earlier *trafficCounts `json:"earlier,omitempty"`
}

type trafficDayRow struct {
	day int64
	c   trafficCounts
}

// queryTrafficHistory is the Overview traffic chart over all time, from the same rows as
// queryApiKeyUsageAllTime plus the errors log and its rollups for the retried attempts.
func queryTrafficHistory(now time.Time, tzOffsetMin int) (trafficHistoryResponse, error) {
	off := int64(tzOffsetMin) * 60
	curDay := localDay(now.Unix(), off)
	resp := trafficHistoryResponse{Range: usageRangeAll, TZOffset: tzOffsetMin, NowUnix: now.Unix()}

	d, err := db.Get()
	if err != nil {
		return resp, err
	}
	tx, err := d.Begin()
	if err != nil {
		return resp, err
	}
	defer tx.Rollback()

	var dated []trafficDayRow
	firstDay := curDay
	scan := func(query string, args []interface{}, read func(*trafficDayRow) []interface{}) error {
		rows, err := tx.Query(query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row trafficDayRow
			if err := rows.Scan(read(&row)...); err != nil {
				return err
			}
			dated = append(dated, row)
			if row.day < firstDay {
				firstDay = row.day
			}
		}
		return rows.Err()
	}
	outcome := func(row *trafficDayRow) []interface{} {
		return []interface{}{&row.day, &row.c.Succeeded, &row.c.Failed}
	}
	retried := func(row *trafficDayRow) []interface{} {
		return []interface{}{&row.day, &row.c.Retried}
	}
	steps := []struct {
		query string
		args  []interface{}
		read  func(*trafficDayRow) []interface{}
	}{
		{`SELECT (ts + ?) / ? AS b,
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END), 0)
FROM requests GROUP BY b`, []interface{}{off, daySeconds}, outcome},
		{`SELECT day,
COALESCE(SUM(CASE WHEN success = 1 THEN request_count ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE request_count END), 0)
FROM request_rollup_daily GROUP BY day`, nil, outcome},
		{`SELECT (ts + ?) / ? AS b, COUNT(*) FROM errors GROUP BY b`, []interface{}{off, daySeconds}, retried},
		{`SELECT day, COALESCE(SUM(error_count), 0) FROM error_rollup_daily GROUP BY day`, nil, retried},
	}
	for _, step := range steps {
		if err := scan(step.query, step.args, step.read); err != nil {
			return resp, err
		}
	}

	layout := newLifetimeLayout(firstDay, curDay)
	resp.Bucket = layout.bucket
	resp.BucketSeconds = layout.bucketSec
	resp.Buckets = layout.unixStarts(off)
	resp.From = layout.starts[0]*daySeconds - off
	resp.To = layout.end*daySeconds - off
	resp.Series = make([]trafficCounts, len(layout.starts))
	for _, row := range dated {
		if idx := layout.index(row.day); idx >= 0 {
			resp.Series[idx].add(row.c)
			resp.Totals.add(row.c)
		}
	}

	var earlier trafficCounts
	rows, err := tx.Query(undatedRequestsSQL)
	if err != nil {
		return resp, err
	}
	for rows.Next() {
		var (
			keyID   string
			success bool
			n       int64
			ignored [3]float64
		)
		if err := rows.Scan(&keyID, &success, &n, &ignored[0], &ignored[1], &ignored[2]); err != nil {
			rows.Close()
			return resp, err
		}
		if success {
			earlier.Succeeded += n
		} else {
			earlier.Failed += n
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return resp, err
	}
	if err := tx.QueryRow(undatedErrorsSQL).Scan(&earlier.Retried); err != nil {
		return resp, err
	}
	if earlier != (trafficCounts{}) {
		resp.Totals.add(earlier)
		resp.Earlier = &earlier
	}
	return resp, nil
}

// apiObserveTrafficHistory serves GET /admin/api/observe/traffic-history?tzOffset=<minutes>: the
// Overview traffic chart's all-time range.
func (h *Handler) apiObserveTrafficHistory(w http.ResponseWriter, r *http.Request) {
	tz, ok := parseTZOffset(r.URL.Query().Get("tzOffset"))
	if !ok {
		writeAdminError(w, http.StatusBadRequest, codeInvalidTZOffset, "tzOffset must be whole minutes between -840 and 840")
		return
	}
	resp, err := queryTrafficHistory(observeNow(), tz)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	json.NewEncoder(w).Encode(resp)
}

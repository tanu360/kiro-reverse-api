package proxy

import (
	"database/sql"
	"strings"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

func persistRequestRecord(rec requestRecord) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	success := 0
	if rec.Success {
		success = 1
	}
	_, err = d.Exec(`INSERT INTO requests
(ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message, endpoint, duration_ms, error_type, cache_read_tokens, cache_write_tokens, attempts_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.TS, rec.AccountID, rec.APIKeyID, rec.APIKey, rec.Email, rec.Model, rec.InTokens, rec.OutTokens, rec.TotalTokens,
		rec.Credits, success, rec.Status, rec.Message, rec.Endpoint, rec.DurationMs, rec.ErrorType, rec.CacheRead, rec.CacheWrite, encodeAttempts(rec.Attempts))
	return err
}

func persistErrorRecord(rec errorRecord) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO errors
(ts, account_id, email, model, status, message)
VALUES (?, ?, ?, ?, ?, ?)`,
		rec.TS, rec.AccountID, rec.Email, rec.Model, rec.Status, rec.Message)
	return err
}

type persistedRequestStats struct {
	TotalRequests    int64
	SuccessRequests  int64
	FailedRequests   int64
	TotalTokens      int64
	TotalCredits     float64
	SuccessTokens    int64
	SuccessInTokens  int64
	SuccessOutTokens int64
	SuccessCredits   float64
	TotalErrorEvents int64
}

func queryPersistedRequestStats() (persistedRequestStats, error) {
	d, err := db.Get()
	if err != nil {
		return persistedRequestStats{}, err
	}

	//! One statement over the logs and the rollups of the rows log retention
	//! pruned: it reads one snapshot, so a prune between two reads can neither
	//! count a row twice nor miss it.
	var stats persistedRequestStats
	err = d.QueryRow(`SELECT
r.total + a.total,
r.ok + a.ok,
r.failed + a.failed,
r.tokens + a.tokens,
r.credits + a.credits,
r.ok_tokens + a.ok_tokens,
r.ok_in + a.ok_in,
r.ok_out + a.ok_out,
r.ok_credits + a.ok_credits,
(SELECT COUNT(*) FROM errors) + (SELECT COALESCE(SUM(error_count), 0) FROM error_rollup)
FROM (SELECT
COUNT(*) AS total,
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS ok,
COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed,
COALESCE(SUM(total_tokens), 0) AS tokens,
COALESCE(SUM(credits), 0) AS credits,
COALESCE(SUM(CASE WHEN success = 1 THEN total_tokens ELSE 0 END), 0) AS ok_tokens,
COALESCE(SUM(CASE WHEN success = 1 THEN in_tokens ELSE 0 END), 0) AS ok_in,
COALESCE(SUM(CASE WHEN success = 1 THEN out_tokens ELSE 0 END), 0) AS ok_out,
COALESCE(SUM(CASE WHEN success = 1 THEN credits ELSE 0 END), 0) AS ok_credits
FROM requests) r, (SELECT
COALESCE(SUM(request_count), 0) AS total,
COALESCE(SUM(CASE WHEN success = 1 THEN request_count ELSE 0 END), 0) AS ok,
COALESCE(SUM(CASE WHEN success = 0 THEN request_count ELSE 0 END), 0) AS failed,
COALESCE(SUM(total_tokens), 0) AS tokens,
COALESCE(SUM(credits), 0) AS credits,
COALESCE(SUM(CASE WHEN success = 1 THEN total_tokens ELSE 0 END), 0) AS ok_tokens,
COALESCE(SUM(CASE WHEN success = 1 THEN in_tokens ELSE 0 END), 0) AS ok_in,
COALESCE(SUM(CASE WHEN success = 1 THEN out_tokens ELSE 0 END), 0) AS ok_out,
COALESCE(SUM(CASE WHEN success = 1 THEN credits ELSE 0 END), 0) AS ok_credits
FROM request_rollup) a`).Scan(
		&stats.TotalRequests,
		&stats.SuccessRequests,
		&stats.FailedRequests,
		&stats.TotalTokens,
		&stats.TotalCredits,
		&stats.SuccessTokens,
		&stats.SuccessInTokens,
		&stats.SuccessOutTokens,
		&stats.SuccessCredits,
		&stats.TotalErrorEvents,
	)
	return stats, err
}

func enqueuePersistRequestRecord(rec requestRecord) {
	if err := persistRequestRecord(rec); err != nil {
		logger.Warnf("[Observe] Persist request failed: %v", err)
	}
}

func escapeSQLLike(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '%' || r == '_' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func queryPersistedRequests(q requestQuery) (requestPage, error) {
	q = normalizeRequestQuery(q)
	d, err := db.Get()
	if err != nil {
		return requestPage{}, err
	}

	var where []string
	var args []interface{}
	switch q.Status {
	case "success":
		where = append(where, "success = 1")
	case "failed":
		where = append(where, "success = 0")
	}
	if q.Search != "" {
		like := "%" + escapeSQLLike(q.Search) + "%"
		where = append(where, "(email LIKE ? ESCAPE '\\' OR account_id LIKE ? ESCAPE '\\' OR api_key_id LIKE ? ESCAPE '\\' OR api_key LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR endpoint LIKE ? ESCAPE '\\' OR error_type LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like, like, like, like, like, like)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	if err := d.QueryRow("SELECT COUNT(*) FROM requests"+whereSQL, args...).Scan(&total); err != nil {
		return requestPage{}, err
	}

	orderBy := map[string]string{
		"time":     "ts",
		"status":   "success",
		"account":  "LOWER(email || account_id)",
		"api_key":  "LOWER(api_key || api_key_id)",
		"model":    "model",
		"tokens":   "total_tokens",
		"credits":  "credits",
		"duration": "duration_ms",
	}[q.Sort]
	if orderBy == "" {
		orderBy = "ts"
	}
	order := "DESC"
	if q.Order == "asc" {
		order = "ASC"
	}
	offset := (q.Page - 1) * q.PageSize
	queryArgs := append([]interface{}{}, args...)
	queryArgs = append(queryArgs, q.PageSize, offset)
	rows, err := d.Query(`SELECT id, ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message, endpoint, duration_ms, error_type, cache_read_tokens, cache_write_tokens, attempts_json
FROM requests`+whereSQL+` ORDER BY `+orderBy+` `+order+`, id `+order+` LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return requestPage{}, err
	}
	defer rows.Close()

	requests := make([]requestRecord, 0, q.PageSize)
	for rows.Next() {
		var rec requestRecord
		var success int
		var attemptsJSON string
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.AccountID, &rec.APIKeyID, &rec.APIKey, &rec.Email, &rec.Model, &rec.InTokens, &rec.OutTokens, &rec.TotalTokens, &rec.Credits, &success, &rec.Status, &rec.Message, &rec.Endpoint, &rec.DurationMs, &rec.ErrorType, &rec.CacheRead, &rec.CacheWrite, &attemptsJSON); err != nil {
			return requestPage{}, err
		}
		rec.Success = success == 1
		rec.APIKeyMasked = requestAPIKeyMasked(rec.APIKeyID, rec.APIKey)
		rec.Attempts = decodeAttempts(attemptsJSON)
		requests = append(requests, rec)
	}
	if err := rows.Err(); err != nil {
		return requestPage{}, err
	}

	return requestPage{
		Requests:   requests,
		Total:      total,
		Page:       q.Page,
		PageSize:   q.PageSize,
		Sort:       q.Sort,
		Order:      q.Order,
		Persistent: true,
	}, nil
}

func loadRecentRequestsFromDB(limit int) ([]requestRecord, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT id, ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message, endpoint, duration_ms, error_type, cache_read_tokens, cache_write_tokens, attempts_json
FROM requests ORDER BY ts DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []requestRecord
	for rows.Next() {
		var rec requestRecord
		var success int
		var attemptsJSON string
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.AccountID, &rec.APIKeyID, &rec.APIKey, &rec.Email, &rec.Model, &rec.InTokens, &rec.OutTokens, &rec.TotalTokens, &rec.Credits, &success, &rec.Status, &rec.Message, &rec.Endpoint, &rec.DurationMs, &rec.ErrorType, &rec.CacheRead, &rec.CacheWrite, &attemptsJSON); err != nil {
			return nil, err
		}
		rec.Success = success == 1
		rec.APIKeyMasked = requestAPIKeyMasked(rec.APIKeyID, rec.APIKey)
		rec.Attempts = decodeAttempts(attemptsJSON)
		out = append(out, rec)
	}
	return out, rows.Err()
}

func loadRecentErrorsFromDB(limit int) ([]errorRecord, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT ts, account_id, email, model, status, message
FROM errors ORDER BY ts DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []errorRecord
	for rows.Next() {
		var rec errorRecord
		var email, model, message sql.NullString
		if err := rows.Scan(&rec.TS, &rec.AccountID, &email, &model, &rec.Status, &message); err != nil {
			return nil, err
		}
		rec.Email = email.String
		rec.Model = model.String
		rec.Message = message.String
		out = append(out, rec)
	}
	return out, rows.Err()
}

// minuteRow is one minute of one account's traffic, summed from SQLite.
type minuteRow struct {
	minute    int64
	accountID string
	bucket    minuteBucket
}

// loadMinuteRowsFromDB sums the requests and retries (the errors table holds
// one row per failed upstream attempt) of every minute from sinceMin on, per
// account. The ts index keeps both scans to the window.
func loadMinuteRowsFromDB(sinceMin int64) ([]minuteRow, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT ts/60 AS m, account_id, COUNT(*),
COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(in_tokens), 0), COALESCE(SUM(out_tokens), 0),
COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
COALESCE(SUM(credits), 0)
FROM requests WHERE ts >= ? GROUP BY m, account_id`, sinceMin*60)
	if err != nil {
		return nil, err
	}
	var out []minuteRow
	for rows.Next() {
		var r minuteRow
		b := &r.bucket
		if err := rows.Scan(&r.minute, &r.accountID, &b.Reqs, &b.Failures, &b.InTokens, &b.OutTokens, &b.CacheReadTokens, &b.CacheWriteTokens, &b.Credits); err != nil {
			rows.Close()
			return nil, err
		}
		b.Successes = b.Reqs - b.Failures
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = d.Query(`SELECT ts/60 AS m, account_id, COUNT(*) FROM errors WHERE ts >= ? GROUP BY m, account_id`, sinceMin*60)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r minuteRow
		if err := rows.Scan(&r.minute, &r.accountID, &r.bucket.Retries); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// loadModelStatsFromDB sums the logged requests and retries per model, up to
// and including the given row ids, so the model mix covers everything since
// the last stats reset. Rows without an account (rejected before one was
// tried) carry whatever model the client sent and are left out. The rows log
// retention pruned count from the rollups; each sum is one statement, so a
// prune running meanwhile moves rows from one side to the other unseen.
func loadModelStatsFromDB(maxRequestID, maxErrorID int64) (map[string]*modelStat, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	stats := make(map[string]*modelStat)
	rows, err := d.Query(`SELECT model, SUM(n), SUM(i), SUM(o), SUM(cr), SUM(cw), SUM(c), MAX(lt) FROM (
SELECT model, COUNT(*) AS n,
COALESCE(SUM(in_tokens), 0) AS i, COALESCE(SUM(out_tokens), 0) AS o,
COALESCE(SUM(cache_read_tokens), 0) AS cr, COALESCE(SUM(cache_write_tokens), 0) AS cw,
COALESCE(SUM(credits), 0) AS c, COALESCE(MAX(ts), 0) AS lt
FROM requests WHERE id <= ? AND model != '' AND account_id != '' GROUP BY model
UNION ALL
SELECT model, SUM(request_count), SUM(in_tokens), SUM(out_tokens),
SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(credits), MAX(last_ts)
FROM request_rollup WHERE model != '' AND account_id != '' GROUP BY model
) GROUP BY model`, maxRequestID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model string
		ms := &modelStat{}
		if err := rows.Scan(&model, &ms.Reqs, &ms.InTokens, &ms.OutTokens, &ms.CacheReadTokens, &ms.CacheWriteTokens, &ms.Credits, &ms.LastUsed); err != nil {
			rows.Close()
			return nil, err
		}
		stats[model] = ms
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = d.Query(`SELECT model, SUM(n) FROM (
SELECT model, COUNT(*) AS n FROM errors WHERE id <= ? AND model != '' AND account_id != '' GROUP BY model
UNION ALL
SELECT model, SUM(error_count) FROM error_rollup WHERE model != '' AND account_id != '' GROUP BY model
) GROUP BY model`, maxErrorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var model string
		var retries int64
		if err := rows.Scan(&model, &retries); err != nil {
			return nil, err
		}
		ms, ok := stats[model]
		if !ok {
			ms = &modelStat{}
			stats[model] = ms
		}
		ms.Retries = retries
	}
	return stats, rows.Err()
}

// maxLoggedIDs is the newest request and error row ids.
func maxLoggedIDs() (requestID, errorID int64, err error) {
	d, err := db.Get()
	if err != nil {
		return 0, 0, err
	}
	if err := d.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM requests`).Scan(&requestID); err != nil {
		return 0, 0, err
	}
	if err := d.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM errors`).Scan(&errorID); err != nil {
		return 0, 0, err
	}
	return requestID, errorID, nil
}

// modelWarmup is the model-mix half of a LoadFromDB, left to run later: it
// sums every row up to the ids logged when the rings were rebuilt.
type modelWarmup struct {
	store                    *observeStore
	maxRequestID, maxErrorID int64
	// generation is the store's reset count the rings were rebuilt at; a
	// reset since then (a stats reset) makes the logged totals stale.
	generation uint64
}

// LoadFromDB rebuilds the store from SQLite: the last day of minute rings, the
// model mix and the recent request and error lists. It replaces what the store
// held, so calling it twice counts nothing twice.
func (s *observeStore) LoadFromDB() error {
	warmup, err := s.loadWindowFromDB()
	if err != nil {
		return err
	}
	return warmup.run()
}

// loadWindowFromDB resets the store and rebuilds the rings and recent lists,
// which index scans keep fast. The model mix scans the whole log, so it is
// left to the returned warmup; requests logged meanwhile count live on top.
func (s *observeStore) loadWindowFromDB() (*modelWarmup, error) {
	if s == nil {
		return &modelWarmup{}, nil
	}
	reqs, err := loadRecentRequestsFromDB(observeRecentReqs)
	if err != nil {
		return nil, err
	}
	errs, err := loadRecentErrorsFromDB(observeRecentErrs)
	if err != nil {
		return nil, err
	}
	_, curMin := curSlot(observeNow().Unix())
	sinceMin := curMin - observeMinuteSlots + 1
	minutes, err := loadMinuteRowsFromDB(sinceMin)
	if err != nil {
		return nil, err
	}
	//! Read before the reset: a request counted after it is logged after it too,
	//! so the warmup's id bound never counts it a second time.
	maxRequestID, maxErrorID, err := maxLoggedIDs()
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	s.resetLocked()
	generation := s.generation
	for i := len(reqs) - 1; i >= 0; i-- {
		s.recentRequests[s.recentReqIdx] = reqs[i]
		s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	}
	for i := len(errs) - 1; i >= 0; i-- {
		s.recentErrors[s.recentErrIdx] = errs[i]
		s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
	}
	for _, row := range minutes {
		//! Rows past the current minute (a clock step back) would overwrite live slots.
		if row.minute < sinceMin || row.minute > curMin {
			continue
		}
		slot := int(row.minute % observeMinuteSlots)
		addMinute(touchBucket(&s.globalRing, slot, row.minute), row.bucket)
		if ring := s.getOrCreateAccountRing(row.accountID); ring != nil {
			addMinute(touchBucket(ring, slot, row.minute), row.bucket)
		}
	}
	s.mu.Unlock()
	s.seq.Add(1)

	logger.Infof("[Observe] Warmed %d requests, %d errors, %d minute rows from db", len(reqs), len(errs), len(minutes))
	return &modelWarmup{store: s, maxRequestID: maxRequestID, maxErrorID: maxErrorID, generation: generation}, nil
}

// run adds the logged model totals to the model mix, on top of whatever was
// counted live since loadWindowFromDB.
func (w *modelWarmup) run() error {
	if w == nil || w.store == nil {
		return nil
	}
	models, err := loadModelStatsFromDB(w.maxRequestID, w.maxErrorID)
	if err != nil {
		return err
	}
	s := w.store
	s.mu.Lock()
	if s.generation != w.generation {
		s.mu.Unlock()
		return nil
	}
	for model, logged := range models {
		ms := s.modelStatLocked(model)
		ms.Reqs += logged.Reqs
		ms.Retries += logged.Retries
		ms.InTokens += logged.InTokens
		ms.OutTokens += logged.OutTokens
		ms.CacheReadTokens += logged.CacheReadTokens
		ms.CacheWriteTokens += logged.CacheWriteTokens
		ms.Credits += logged.Credits
		ms.LastUsed = max(ms.LastUsed, logged.LastUsed)
	}
	s.mu.Unlock()
	s.seq.Add(1)

	logger.Infof("[Observe] Warmed %d models from db", len(models))
	return nil
}

func addMinute(dst *minuteBucket, src minuteBucket) {
	dst.Reqs += src.Reqs
	dst.Successes += src.Successes
	dst.Failures += src.Failures
	dst.Retries += src.Retries
	dst.InTokens += src.InTokens
	dst.OutTokens += src.OutTokens
	dst.CacheReadTokens += src.CacheReadTokens
	dst.CacheWriteTokens += src.CacheWriteTokens
	dst.Credits += src.Credits
}

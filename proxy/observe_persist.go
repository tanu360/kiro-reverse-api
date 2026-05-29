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
(ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.TS, rec.AccountID, rec.APIKeyID, rec.APIKey, rec.Email, rec.Model, rec.InTokens, rec.OutTokens, rec.TotalTokens,
		rec.Credits, success, rec.Status, rec.Message)
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

	var stats persistedRequestStats
	err = d.QueryRow(`SELECT
COUNT(*),
COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(total_tokens), 0),
COALESCE(SUM(credits), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN total_tokens ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN in_tokens ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN out_tokens ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN success = 1 THEN credits ELSE 0 END), 0)
FROM requests`).Scan(
		&stats.TotalRequests,
		&stats.SuccessRequests,
		&stats.FailedRequests,
		&stats.TotalTokens,
		&stats.TotalCredits,
		&stats.SuccessTokens,
		&stats.SuccessInTokens,
		&stats.SuccessOutTokens,
		&stats.SuccessCredits,
	)
	if err != nil {
		return stats, err
	}
	err = d.QueryRow(`SELECT COUNT(*) FROM errors`).Scan(&stats.TotalErrorEvents)
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
		where = append(where, "(email LIKE ? ESCAPE '\\' OR account_id LIKE ? ESCAPE '\\' OR api_key_id LIKE ? ESCAPE '\\' OR api_key LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like, like, like, like)
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
		"time":    "ts",
		"status":  "success",
		"account": "LOWER(email || account_id)",
		"api_key": "LOWER(api_key || api_key_id)",
		"model":   "model",
		"tokens":  "total_tokens",
		"credits": "credits",
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
	rows, err := d.Query(`SELECT id, ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message
FROM requests`+whereSQL+` ORDER BY `+orderBy+` `+order+`, id `+order+` LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return requestPage{}, err
	}
	defer rows.Close()

	requests := make([]requestRecord, 0, q.PageSize)
	for rows.Next() {
		var rec requestRecord
		var success int
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.AccountID, &rec.APIKeyID, &rec.APIKey, &rec.Email, &rec.Model, &rec.InTokens, &rec.OutTokens, &rec.TotalTokens, &rec.Credits, &success, &rec.Status, &rec.Message); err != nil {
			return requestPage{}, err
		}
		rec.Success = success == 1
		rec.APIKeyMasked = requestAPIKeyMasked(rec.APIKeyID, rec.APIKey)
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
	rows, err := d.Query(`SELECT id, ts, account_id, api_key_id, api_key, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message
FROM requests ORDER BY ts DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []requestRecord
	for rows.Next() {
		var rec requestRecord
		var success int
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.AccountID, &rec.APIKeyID, &rec.APIKey, &rec.Email, &rec.Model, &rec.InTokens, &rec.OutTokens, &rec.TotalTokens, &rec.Credits, &success, &rec.Status, &rec.Message); err != nil {
			return nil, err
		}
		rec.Success = success == 1
		rec.APIKeyMasked = requestAPIKeyMasked(rec.APIKeyID, rec.APIKey)
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

func (s *observeStore) LoadFromDB() error {
	if s == nil {
		return nil
	}
	reqs, err := loadRecentRequestsFromDB(observeRecentReqs)
	if err != nil {
		return err
	}
	errs, err := loadRecentErrorsFromDB(observeRecentErrs)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := len(reqs) - 1; i >= 0; i-- {
		s.recentRequests[s.recentReqIdx] = reqs[i]
		s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	}
	for i := len(errs) - 1; i >= 0; i-- {
		s.recentErrors[s.recentErrIdx] = errs[i]
		s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
	}
	logger.Infof("[Observe] Warmed %d requests, %d errors from db", len(reqs), len(errs))
	return nil
}

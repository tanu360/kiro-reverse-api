// Package proxy: observe data persistence.
package proxy

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"kiro-go/config"
	"kiro-go/logger"

	_ "modernc.org/sqlite"
)

const observeDataFileName = "observe.json"
const observeRequestsDBFileName = "requests.sqlite"
const observeRequestPersistQueueSize = 4096

var (
	observeDBOnce               sync.Once
	observeDB                   *sql.DB
	observeDBErr                error
	observeRequestPersistOnce   sync.Once
	observeRequestPersistQueue  chan requestRecord
	observePersistWriterActive  atomic.Bool
	observePersistWriterStarted atomic.Bool
)

// observePersistData 持久化数据结构
type observePersistData struct {
	SavedAt        int64           `json:"savedAt"`
	RecentRequests []requestRecord `json:"recentRequests"`
	RecentErrors   []errorRecord   `json:"recentErrors"`
}

func observeDir() string {
	return filepath.Join(config.GetDataDir(), "observe")
}

func observeDataPath() string {
	return filepath.Join(observeDir(), observeDataFileName)
}

func observeRequestsDBPath() string {
	return filepath.Join(observeDir(), observeRequestsDBFileName)
}

func getObserveRequestPersistQueue() chan requestRecord {
	observeRequestPersistOnce.Do(func() {
		observeRequestPersistQueue = make(chan requestRecord, observeRequestPersistQueueSize)
	})
	return observeRequestPersistQueue
}

func getObserveDB() (*sql.DB, error) {
	observeDBOnce.Do(func() {
		if err := os.MkdirAll(observeDir(), 0700); err != nil {
			observeDBErr = err
			return
		}
		db, err := sql.Open("sqlite", observeRequestsDBPath())
		if err != nil {
			observeDBErr = err
			return
		}
		db.SetMaxOpenConns(1)
		if _, err = db.Exec(`PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_success ON requests(success);
CREATE INDEX IF NOT EXISTS idx_requests_lookup ON requests(email, account_id, model);`); err != nil {
			_ = db.Close()
			observeDBErr = err
			return
		}
		observeDB = db
	})
	if observeDBErr != nil {
		return nil, observeDBErr
	}
	if observeDB == nil {
		return nil, fmt.Errorf("observe request database unavailable")
	}
	return observeDB, nil
}

func closeObserveDB() {
	if observeDB != nil {
		_ = observeDB.Close()
		observeDB = nil
	}
	observeDBOnce = sync.Once{}
	observeDBErr = nil
}

func persistRequestRecord(rec requestRecord) error {
	db, err := getObserveDB()
	if err != nil {
		return err
	}
	success := 0
	if rec.Success {
		success = 1
	}
	_, err = db.Exec(`INSERT INTO requests
(ts, account_id, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.TS, rec.AccountID, rec.Email, rec.Model, rec.InTokens, rec.OutTokens, rec.TotalTokens,
		rec.Credits, success, rec.Status, rec.Message)
	return err
}

func enqueuePersistRequestRecord(rec requestRecord) {
	if !observePersistWriterActive.Load() {
		if err := persistRequestRecord(rec); err != nil {
			logger.Warnf("[Observe] Persist request failed: %v", err)
		}
		return
	}
	getObserveRequestPersistQueue() <- rec
}

func persistQueuedRequestRecord(rec requestRecord) {
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
	db, err := getObserveDB()
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
		where = append(where, "(email LIKE ? ESCAPE '\\' OR account_id LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')")
		args = append(args, like, like, like, like)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	if err := db.QueryRow("SELECT COUNT(*) FROM requests"+whereSQL, args...).Scan(&total); err != nil {
		return requestPage{}, err
	}

	orderBy := map[string]string{
		"time":    "ts",
		"status":  "success",
		"account": "LOWER(email || account_id)",
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
	rows, err := db.Query(`SELECT id, ts, account_id, email, model, in_tokens, out_tokens, total_tokens, credits, success, status, message
FROM requests`+whereSQL+` ORDER BY `+orderBy+` `+order+`, id `+order+` LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return requestPage{}, err
	}
	defer rows.Close()

	requests := make([]requestRecord, 0, q.PageSize)
	for rows.Next() {
		var rec requestRecord
		var success int
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.AccountID, &rec.Email, &rec.Model, &rec.InTokens, &rec.OutTokens, &rec.TotalTokens, &rec.Credits, &success, &rec.Status, &rec.Message); err != nil {
			return requestPage{}, err
		}
		rec.Success = success == 1
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

func (h *Handler) backgroundObserveRequestWriter() {
	if !observePersistWriterStarted.CompareAndSwap(false, true) {
		return
	}
	observePersistWriterActive.Store(true)
	defer func() {
		observePersistWriterActive.Store(false)
		observePersistWriterStarted.Store(false)
	}()

	queue := getObserveRequestPersistQueue()
	for {
		select {
		case rec := <-queue:
			persistQueuedRequestRecord(rec)
		case <-h.stopStatsSaver:
			for {
				select {
				case rec := <-queue:
					persistQueuedRequestRecord(rec)
				default:
					closeObserveDB()
					return
				}
			}
		}
	}
}

// Save 保存观测数据到磁盘
func (s *observeStore) Save() error {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	reqs := make([]requestRecord, 0, observeRecentReqs)
	for i := 0; i < observeRecentReqs; i++ {
		idx := (s.recentReqIdx - 1 - i + observeRecentReqs) % observeRecentReqs
		rec := s.recentRequests[idx]
		if rec.TS == 0 {
			continue
		}
		reqs = append(reqs, rec)
	}
	errs := make([]errorRecord, 0, observeRecentErrs)
	for i := 0; i < observeRecentErrs; i++ {
		idx := (s.recentErrIdx - 1 - i + observeRecentErrs) % observeRecentErrs
		rec := s.recentErrors[idx]
		if rec.TS == 0 {
			continue
		}
		errs = append(errs, rec)
	}
	s.mu.RUnlock()

	data := observePersistData{
		SavedAt:        time.Now().Unix(),
		RecentRequests: reqs,
		RecentErrors:   errs,
	}

	dir := filepath.Dir(observeDataPath())
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(observeDataPath(), jsonData, 0600)
}

// Load 从磁盘加载观测数据
func (s *observeStore) Load() error {
	if s == nil {
		return nil
	}
	data, err := os.ReadFile(observeDataPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var persist observePersistData
	if err := json.Unmarshal(data, &persist); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// 恢复请求记录（最新的在前，需要反向写入）
	for i := len(persist.RecentRequests) - 1; i >= 0; i-- {
		s.recentRequests[s.recentReqIdx] = persist.RecentRequests[i]
		s.recentReqIdx = (s.recentReqIdx + 1) % observeRecentReqs
	}

	// 恢复错误记录
	for i := len(persist.RecentErrors) - 1; i >= 0; i-- {
		s.recentErrors[s.recentErrIdx] = persist.RecentErrors[i]
		s.recentErrIdx = (s.recentErrIdx + 1) % observeRecentErrs
	}

	logger.Infof("[Observe] Loaded %d requests, %d errors from %s", len(persist.RecentRequests), len(persist.RecentErrors), observeDataPath())
	return nil
}

// backgroundObserveSaver 后台定期保存观测数据
func (h *Handler) backgroundObserveSaver() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			// 停机前最后保存一次
			if err := getObserveStore().Save(); err != nil {
				logger.Warnf("[Observe] Failed to save on shutdown: %v", err)
			}
			return
		case <-ticker.C:
			if err := getObserveStore().Save(); err != nil {
				logger.Warnf("[Observe] Failed to save: %v", err)
			}
		}
	}
}

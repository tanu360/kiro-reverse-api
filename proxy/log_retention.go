package proxy

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"kiro-proxy/textfmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// Log retention: the requests and errors tables lose their rows older than
// logRetentionDays, in small batches. Each batch adds the rows' totals to
// request_rollup or error_rollup and deletes them in one transaction, and the
// all-time stats (queryPersistedRequestStats, loadModelStatsFromDB) add the
// rollups back, so no lifetime total drops. Any new all-time SUM or COUNT over
// requests or errors must add its rollup too.

const codeLogRetentionRange = "log_retention_range"

// Vars so tests can shrink them.
var (
	// logRetentionStartDelay keeps the first prune off the startup path.
	logRetentionStartDelay = 2 * time.Minute
	logRetentionEvery      = 24 * time.Hour
	// logPruneBatch rows per transaction: the database has one connection, so
	// a request's log write waits for at most one batch.
	logPruneBatch      = 500
	logPruneBatchPause = 50 * time.Millisecond
)

// logRetention is the job's state: one per process, like the observe store.
var logRetention = struct {
	// kick asks the job to run now (the setting was saved).
	kick    chan struct{}
	running atomic.Bool

	mu                 sync.Mutex
	lastRunAt          int64
	lastPrunedRequests int64
	lastPrunedErrors   int64
}{kick: make(chan struct{}, 1)}

// kickLogRetention asks the job for a run now; a kick already pending covers it.
func kickLogRetention() {
	select {
	case logRetention.kick <- struct{}{}:
	default:
	}
}

// backgroundLogRetention prunes the logs a while after startup, then daily,
// and whenever the setting is saved.
func (h *Handler) backgroundLogRetention() {
	timer := time.NewTimer(logRetentionStartDelay)
	defer timer.Stop()
	for {
		select {
		case <-h.stopStatsSaver:
			return
		case <-timer.C:
		case <-logRetention.kick:
		}
		runLogRetention(time.Now(), h.stopStatsSaver)
		timer.Reset(logRetentionEvery)
	}
}

// runLogRetention prunes the logs to the current setting and records the run.
// It does nothing while the setting is 0 (keep forever) or a run is going.
func runLogRetention(now time.Time, stop <-chan struct{}) {
	days := config.GetLogRetentionDays()
	if days <= 0 {
		return
	}
	if !logRetention.running.CompareAndSwap(false, true) {
		return
	}
	defer logRetention.running.Store(false)

	reqs, errs, err := pruneRequestLog(now, days, stop)
	logRetention.mu.Lock()
	logRetention.lastRunAt = now.Unix()
	logRetention.lastPrunedRequests = reqs
	logRetention.lastPrunedErrors = errs
	logRetention.mu.Unlock()
	if err != nil {
		logger.Warnf("[Retention] Prune failed after %s, %s: %v", textfmt.Count(int(reqs), "request", "requests"), textfmt.Count(int(errs), "error", "errors"), err)
	}
	if reqs > 0 || errs > 0 {
		logger.Infof("[Retention] Pruned %s, %s older than %s", textfmt.Count(int(reqs), "request", "requests"), textfmt.Count(int(errs), "error", "errors"), textfmt.Count(days, "day", "days"))
	}
	// The settings card shows the last run.
	publishEvent(eventSettingsChanged, "")
}

// pruneRequestLog moves the request and error rows older than days before now
// into the rollups, a batch at a time. It stops early when stop closes or the
// setting changes; a save kicks a new run with the new value.
func pruneRequestLog(now time.Time, days int, stop <-chan struct{}) (reqs, errs int64, err error) {
	if days <= 0 {
		return 0, 0, nil
	}
	d, err := db.Get()
	if err != nil {
		return 0, 0, err
	}
	cutoff := now.Unix() - int64(days)*86400
	batch := logPruneBatch
	steps := []struct {
		prune func(*sql.DB, int64, int) (int64, error)
		total *int64
	}{
		{pruneRequestsBatch, &reqs},
		{pruneErrorsBatch, &errs},
	}
	for _, step := range steps {
		for {
			n, err := step.prune(d, cutoff, batch)
			*step.total += n
			if err != nil {
				return reqs, errs, err
			}
			if n < int64(batch) {
				break
			}
			if config.GetLogRetentionDays() != days {
				return reqs, errs, nil
			}
			//! The pause hands the one connection to the request path between batches.
			select {
			case <-stop:
				return reqs, errs, nil
			case <-time.After(logPruneBatchPause):
			}
		}
	}
	return reqs, errs, nil
}

// The oldest rows first, ties by id: a total order, so the INSERT and the
// DELETE of one transaction pick the same rows. It walks idx_*_ts backwards.
const (
	prunedRequestIDs = `SELECT id FROM requests WHERE ts < ? ORDER BY ts, id LIMIT ?`
	prunedErrorIDs   = `SELECT id FROM errors WHERE ts < ? ORDER BY ts, id LIMIT ?`
)

// pruneRequestsBatch adds up to limit request rows older than cutoff to
// request_rollup and deletes them, in one transaction. It returns how many it
// deleted.
func pruneRequestsBatch(d *sql.DB, cutoff int64, limit int) (int64, error) {
	tx, err := d.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO request_rollup
(model, account_id, api_key_id, success, request_count, in_tokens, out_tokens, total_tokens, cache_read_tokens, cache_write_tokens, credits, last_ts)
SELECT model, account_id, api_key_id, success, COUNT(*),
COALESCE(SUM(in_tokens), 0), COALESCE(SUM(out_tokens), 0), COALESCE(SUM(total_tokens), 0),
COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
COALESCE(SUM(credits), 0), MAX(ts)
FROM requests WHERE id IN (`+prunedRequestIDs+`)
GROUP BY model, account_id, api_key_id, success
ON CONFLICT (model, account_id, api_key_id, success) DO UPDATE SET
request_count = request_count + excluded.request_count,
in_tokens = in_tokens + excluded.in_tokens,
out_tokens = out_tokens + excluded.out_tokens,
total_tokens = total_tokens + excluded.total_tokens,
cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
credits = credits + excluded.credits,
last_ts = MAX(last_ts, excluded.last_ts)`, cutoff, limit); err != nil {
		return 0, fmt.Errorf("roll up requests: %w", err)
	}
	res, err := tx.Exec(`DELETE FROM requests WHERE id IN (`+prunedRequestIDs+`)`, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("delete requests: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// pruneErrorsBatch is pruneRequestsBatch for the errors table.
func pruneErrorsBatch(d *sql.DB, cutoff int64, limit int) (int64, error) {
	tx, err := d.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO error_rollup (model, account_id, error_count, last_ts)
SELECT model, account_id, COUNT(*), MAX(ts)
FROM errors WHERE id IN (`+prunedErrorIDs+`)
GROUP BY model, account_id
ON CONFLICT (model, account_id) DO UPDATE SET
error_count = error_count + excluded.error_count,
last_ts = MAX(last_ts, excluded.last_ts)`, cutoff, limit); err != nil {
		return 0, fmt.Errorf("roll up errors: %w", err)
	}
	res, err := tx.Exec(`DELETE FROM errors WHERE id IN (`+prunedErrorIDs+`)`, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("delete errors: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// resetRequestLog empties the request and error logs and their rollups, in one
// transaction (Settings > Reset statistics).
func resetRequestLog() error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"requests", "errors", "request_rollup", "error_rollup"} {
		if _, err := tx.Exec(`DELETE FROM ` + table); err != nil {
			return fmt.Errorf("clear %s: %w", table, err)
		}
	}
	return tx.Commit()
}

type logRetentionStatus struct {
	Days        int `json:"days"`
	DefaultDays int `json:"defaultDays"`
	MaxDays     int `json:"maxDays"`
	// The last run since the server started; 0 when none ran yet.
	LastRunAt          int64 `json:"lastRunAt"`
	LastPrunedRequests int64 `json:"lastPrunedRequests"`
	LastPrunedErrors   int64 `json:"lastPrunedErrors"`
	// Requests pruned so far whose totals the rollup keeps.
	ArchivedRequests int64 `json:"archivedRequests"`
	// The oldest request still in the log; 0 when it is empty.
	OldestRequestTs int64 `json:"oldestRequestTs"`
}

func currentLogRetentionStatus() (logRetentionStatus, error) {
	status := logRetentionStatus{
		Days:        config.GetLogRetentionDays(),
		DefaultDays: config.DefaultLogRetentionDays,
		MaxDays:     config.MaxLogRetentionDays,
	}
	logRetention.mu.Lock()
	status.LastRunAt = logRetention.lastRunAt
	status.LastPrunedRequests = logRetention.lastPrunedRequests
	status.LastPrunedErrors = logRetention.lastPrunedErrors
	logRetention.mu.Unlock()

	d, err := db.Get()
	if err != nil {
		return status, err
	}
	err = d.QueryRow(`SELECT
(SELECT COALESCE(SUM(request_count), 0) FROM request_rollup),
(SELECT COALESCE(MIN(ts), 0) FROM requests)`).Scan(&status.ArchivedRequests, &status.OldestRequestTs)
	return status, err
}

func (h *Handler) apiGetLogRetention(w http.ResponseWriter, _ *http.Request) {
	status, err := currentLogRetentionStatus()
	if err != nil {
		// The setting itself still loads; only the log figures are missing.
		logger.Warnf("[Retention] Failed to read the log status: %v", err)
	}
	json.NewEncoder(w).Encode(status)
}

func (h *Handler) apiUpdateLogRetention(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Days *int `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if req.Days == nil || *req.Days < 0 || *req.Days > config.MaxLogRetentionDays {
		writeAdminError(w, http.StatusBadRequest, codeLogRetentionRange,
			fmt.Sprintf("days must be between 0 and %d", config.MaxLogRetentionDays))
		return
	}
	if err := config.UpdateLogRetentionDays(*req.Days); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	publishEvent(eventSettingsChanged, "")
	kickLogRetention()
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

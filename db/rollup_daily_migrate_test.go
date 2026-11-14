package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A kiro.db from a 3.3.0 build before the daily rollups: its logs and the totals log retention
// already pruned stay as they are, and the two daily tables are added empty, on every open.
func TestDailyRollupTablesAddedToExistingDB(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  api_key_id TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_type TEXT NOT NULL DEFAULT '',
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  attempts_json TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_requests_ts ON requests(ts DESC, id DESC);
CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE TABLE request_rollup (
  model              TEXT NOT NULL DEFAULT '',
  account_id         TEXT NOT NULL DEFAULT '',
  api_key_id         TEXT NOT NULL DEFAULT '',
  success            INTEGER NOT NULL DEFAULT 0,
  request_count      INTEGER NOT NULL DEFAULT 0,
  in_tokens          INTEGER NOT NULL DEFAULT 0,
  out_tokens         INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  credits            REAL NOT NULL DEFAULT 0,
  last_ts            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, account_id, api_key_id, success)
);
CREATE TABLE error_rollup (
  model       TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  error_count INTEGER NOT NULL DEFAULT 0,
  last_ts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, account_id)
);
INSERT INTO requests (ts, account_id, api_key_id, model, success) VALUES (5000000, 'acc-a', 'key-1', 'auto', 1);
INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count, in_tokens, credits, last_ts)
  VALUES ('auto', 'acc-a', 'key-1', 1, 12, 340, 1.5, 100);
INSERT INTO error_rollup (model, account_id, error_count, last_ts) VALUES ('auto', 'acc-a', 4, 90);`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Close() })
	for i := 0; i < 2; i++ {
		d, err := Get()
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		var reqs, rolled, rolledErrs, daily, dailyErrs int
		if err := d.QueryRow(`SELECT
  (SELECT COUNT(*) FROM requests),
  (SELECT SUM(request_count) FROM request_rollup), (SELECT SUM(error_count) FROM error_rollup),
  (SELECT COUNT(*) FROM request_rollup_daily), (SELECT COUNT(*) FROM error_rollup_daily)`).Scan(&reqs, &rolled, &rolledErrs, &daily, &dailyErrs); err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		if reqs != 1 || rolled != 12 || rolledErrs != 4 {
			t.Fatalf("open %d: %d requests, rollups %d and %d; want 1, 12, 4", i, reqs, rolled, rolledErrs)
		}
		if daily != 0 || dailyErrs != 0 {
			t.Fatalf("open %d: daily rollups = %d, %d rows; want both empty", i, daily, dailyErrs)
		}
		//! The prune upserts by these keys: a second row of one group must conflict.
		if _, err := d.Exec(`INSERT INTO request_rollup_daily (day, model, account_id, api_key_id, keyless, success, request_count)
VALUES (57, 'auto', 'acc-a', '', 1, 0, 1)
ON CONFLICT (day, model, account_id, api_key_id, keyless, success) DO UPDATE SET request_count = request_count + excluded.request_count`); err != nil {
			t.Fatalf("open %d: upsert request_rollup_daily: %v", i, err)
		}
		if _, err := d.Exec(`INSERT INTO error_rollup_daily (day, model, account_id, error_count) VALUES (57, 'auto', 'acc-a', 1)
ON CONFLICT (day, model, account_id) DO UPDATE SET error_count = error_count + excluded.error_count`); err != nil {
			t.Fatalf("open %d: upsert error_rollup_daily: %v", i, err)
		}
		if _, err := d.Exec(`DELETE FROM request_rollup_daily; DELETE FROM error_rollup_daily`); err != nil {
			t.Fatal(err)
		}
		//! A second open runs the same DDL again over the tables the first one made.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

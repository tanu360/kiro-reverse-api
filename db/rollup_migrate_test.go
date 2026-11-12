package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A kiro.db from before log retention: its request and error logs stay as they
// are, and the two rollup tables are added empty, on every open.
func TestRollupTablesAddedToExistingDB(t *testing.T) {
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
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
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
INSERT INTO requests (ts, account_id, model, in_tokens, out_tokens, total_tokens, credits, success) VALUES
  (100, 'acc-a', 'claude-sonnet-4.5', 7, 3, 10, 0.5, 1),
  (200, 'acc-b', 'auto', 1, 1, 2, 0.25, 0);
INSERT INTO errors (ts, account_id, model, status) VALUES (150, 'acc-b', 'auto', 500);`); err != nil {
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
		var reqs, tokens, errs, reqRollup, errRollup int
		if err := d.QueryRow(`SELECT
  (SELECT COUNT(*) FROM requests), (SELECT SUM(total_tokens) FROM requests),
  (SELECT COUNT(*) FROM errors),
  (SELECT COUNT(*) FROM request_rollup), (SELECT COUNT(*) FROM error_rollup)`).Scan(&reqs, &tokens, &errs, &reqRollup, &errRollup); err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		if reqs != 2 || tokens != 12 || errs != 1 {
			t.Fatalf("open %d: logs = %d requests (%d tokens), %d errors; want 2 (12), 1", i, reqs, tokens, errs)
		}
		if reqRollup != 0 || errRollup != 0 {
			t.Fatalf("open %d: rollups = %d, %d rows; want both empty", i, reqRollup, errRollup)
		}
		//! A second open runs the same DDL again over the tables the first one made.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

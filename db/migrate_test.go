package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestRequestsTableGainsCacheColumnsAndKeepsOldRows(t *testing.T) {
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
  error_type TEXT NOT NULL DEFAULT ''
);
INSERT INTO requests (ts, model, in_tokens, out_tokens, total_tokens) VALUES (1, 'legacy', 7, 3, 10);`); err != nil {
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
		var read, write, total int
		if err := d.QueryRow(`SELECT cache_read_tokens, cache_write_tokens, total_tokens FROM requests WHERE model = 'legacy'`).Scan(&read, &write, &total); err != nil {
			t.Fatal(err)
		}
		if read != 0 || write != 0 || total != 10 {
			t.Fatalf("legacy row = read %d write %d total %d", read, write, total)
		}
		//! A second open must not try to add the columns again.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRequestsTableGainsRequestIDColumn(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	//! The table as the release before request ids left it: cache columns, no request_id.
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
INSERT INTO requests (ts, model, total_tokens) VALUES (1, 'legacy', 10);`); err != nil {
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
		var requestID string
		var total int
		if err := d.QueryRow(`SELECT request_id, total_tokens FROM requests WHERE model = 'legacy'`).Scan(&requestID, &total); err != nil {
			t.Fatal(err)
		}
		if requestID != "" || total != 10 {
			t.Fatalf("legacy row = request_id %q total %d", requestID, total)
		}
		if _, err := d.Exec(`INSERT INTO requests (ts, model, request_id) VALUES (2, 'new', 'req_0123456789abcdef01234567')`); err != nil {
			t.Fatalf("insert with request_id on open %d: %v", i, err)
		}
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

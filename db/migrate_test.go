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

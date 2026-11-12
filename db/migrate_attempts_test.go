package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestRequestsTableGainsAttemptsColumnAndKeepsOldRows(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	//! The requests table as the release before the attempt chain left it.
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
INSERT INTO requests (ts, model, in_tokens, out_tokens, total_tokens, cache_read_tokens) VALUES (1, 'legacy', 7, 3, 10, 4);`); err != nil {
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
		var attempts string
		var read, total int
		if err := d.QueryRow(`SELECT attempts_json, cache_read_tokens, total_tokens FROM requests WHERE model = 'legacy'`).Scan(&attempts, &read, &total); err != nil {
			t.Fatal(err)
		}
		if attempts != "" || read != 4 || total != 10 {
			t.Fatalf("legacy row = attempts %q read %d total %d", attempts, read, total)
		}
		//! A second open must not try to add the column again.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}

	d, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO requests (ts, model, attempts_json) VALUES (2, 'new', '[{"accountId":"a"}]')`); err != nil {
		t.Fatalf("insert with attempts: %v", err)
	}
	var stored string
	if err := d.QueryRow(`SELECT attempts_json FROM requests WHERE model = 'new'`).Scan(&stored); err != nil || stored != `[{"accountId":"a"}]` {
		t.Fatalf("attempts_json = %q, err %v", stored, err)
	}
}

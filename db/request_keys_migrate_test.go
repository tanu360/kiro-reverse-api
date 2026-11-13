package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A kiro.db from before 3.3.0 holds the raw client key of every request. The
// migration gives a configured key's rows its id, then masks every value, and
// a second run on the next start changes nothing.
func TestMaskRequestKeysMasksRawKeysInAnOlderDB(t *testing.T) {
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
INSERT INTO requests (ts, api_key_id, api_key) VALUES
  (1, 'key-on', 'sk-served-0123456789abcdef'),
  (2, '', 'sk-disabled-0123456789abcdef'),
  (3, '', 'sk-someone-elses-real-secret-0000'),
  (4, '', 'sk-bogus'),
  (5, '', ''),
  (6, 'key-on', 'sk-ser****cdef'),
  (7, '', '****'),
  (8, '', 'ключ-чужой-0000');`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Close() })
	keys := map[string]string{
		"sk-served-0123456789abcdef":   "key-on",
		"sk-disabled-0123456789abcdef": "key-off",
	}
	want := []struct{ id, key string }{
		{"key-on", "sk-ser****cdef"},
		{"key-off", "sk-dis****cdef"},
		{"", "sk-som****0000"},
		{"", "****"},
		{"", ""},
		{"key-on", "sk-ser****cdef"},
		{"", "****"},
		//! Bytes, as config.MaskApiKey counts them: 3 Cyrillic letters are 6 bytes.
		{"", "клю****0000"},
	}
	for run, wantMasked := range []int64{5, 0} {
		n, err := MaskRequestKeys(keys)
		if err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
		if n != wantMasked {
			t.Fatalf("run %d masked %d rows, want %d", run, n, wantMasked)
		}
		d, err := Get()
		if err != nil {
			t.Fatal(err)
		}
		rows, err := d.Query(`SELECT api_key_id, api_key FROM requests ORDER BY ts`)
		if err != nil {
			t.Fatal(err)
		}
		i := 0
		for rows.Next() {
			var id, key string
			if err := rows.Scan(&id, &key); err != nil {
				t.Fatal(err)
			}
			if i >= len(want) || id != want[i].id || key != want[i].key {
				t.Fatalf("run %d row %d = (%q, %q)", run, i+1, id, key)
			}
			i++
		}
		rows.Close()
		if i != len(want) {
			t.Fatalf("run %d read %d rows, want %d", run, i, len(want))
		}
		//! The next start opens the same file again.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

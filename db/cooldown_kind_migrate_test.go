package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestCooldownsTableGainsKindColumnAndKeepsOldRows(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE cooldowns (
  account_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
INSERT INTO cooldowns (account_id, expires_at) VALUES ('legacy', 4102444800);`); err != nil {
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
		var kind string
		var exp int64
		if err := d.QueryRow(`SELECT expires_at, kind FROM cooldowns WHERE account_id = 'legacy'`).Scan(&exp, &kind); err != nil {
			t.Fatal(err)
		}
		if exp != 4102444800 || kind != "" {
			t.Fatalf("legacy row = expires %d kind %q", exp, kind)
		}
		//! An older binary's insert names no kind and must still work.
		if _, err := d.Exec(`INSERT OR REPLACE INTO cooldowns(account_id, expires_at) VALUES('old-binary', 1)`); err != nil {
			t.Fatalf("insert without kind: %v", err)
		}
		//! A second open must not try to add the column again.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

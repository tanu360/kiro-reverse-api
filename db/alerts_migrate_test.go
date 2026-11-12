package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestAlertTablesAddedToExistingDatabase(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE cooldowns (account_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
INSERT INTO settings (key, value) VALUES ('config', '{"port":8080}');`); err != nil {
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
		var value string
		if err := d.QueryRow(`SELECT value FROM settings WHERE key = 'config'`).Scan(&value); err != nil || value != `{"port":8080}` {
			t.Fatalf("old row = %q, %v", value, err)
		}
		if _, err := d.Exec(`INSERT OR REPLACE INTO alert_state (key, period, level, sent_at) VALUES ('pool', '', 90, 1)`); err != nil {
			t.Fatalf("alert_state: %v", err)
		}
		if _, err := d.Exec(`INSERT OR REPLACE INTO alert_deliveries (channel_id, ts, ok, status, attempts, event, error) VALUES ('ch_1', 1, 1, 200, 1, 'test', '')`); err != nil {
			t.Fatalf("alert_deliveries: %v", err)
		}
		var level int
		if err := d.QueryRow(`SELECT level FROM alert_state WHERE key = 'pool'`).Scan(&level); err != nil || level != 90 {
			t.Fatalf("alert_state row = %d, %v", level, err)
		}
		//! Reopening must leave the existing tables and rows alone.
		if err := Close(); err != nil {
			t.Fatal(err)
		}
	}
}

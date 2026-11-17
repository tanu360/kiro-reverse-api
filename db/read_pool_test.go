package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// An existing database from before WAL (rollback journal) opens in WAL mode, and Read hands
// out read-only connections of its own that never hold up the writer.
func TestReadPoolReadsBesideTheWriter(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`PRAGMA journal_mode=DELETE; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('kept', 'yes')`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	if err := ResetForTestKeep(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Close() })
	w, err := Get()
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	if err := w.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v; want wal", mode, err)
	}
	r, err := Read()
	if err != nil {
		t.Fatal(err)
	}
	if r == w {
		t.Fatal("Read returned the writer's handle in WAL mode")
	}
	var kept string
	if err := r.QueryRow(`SELECT value FROM settings WHERE key = 'kept'`).Scan(&kept); err != nil || kept != "yes" {
		t.Fatalf("old row through the reader = %q, %v", kept, err)
	}
	if _, err := r.Exec(`INSERT INTO settings VALUES ('nope', 'x')`); err == nil {
		t.Fatal("the reader accepted a write")
	}

	// A read transaction left open (a long search) does not block a write on the writer.
	tx, err := r.Begin()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM settings`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := w.Exec(`INSERT INTO settings VALUES ('during', 'read')`); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("write waited %v behind an open read", took)
	}
	_ = tx.Rollback()

	// A read that starts after a commit sees it.
	var during string
	if err := r.QueryRow(`SELECT value FROM settings WHERE key = 'during'`).Scan(&during); err != nil || during != "read" {
		t.Fatalf("committed row through the reader = %q, %v", during, err)
	}

	if err := Close(); err != nil {
		t.Fatal(err)
	}
	if err := ResetForTest(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{fileName, fileName + "-wal", fileName + "-shm"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s left behind after ResetForTest: %v", name, err)
		}
	}
}

// ResetForTestKeep points the package at dir without deleting the database there.
func ResetForTestKeep(dir string) error {
	if err := Close(); err != nil {
		return err
	}
	mu.Lock()
	dataDir = dir
	mu.Unlock()
	return nil
}

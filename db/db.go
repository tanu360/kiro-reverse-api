package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

const fileName = "kiro.db"

var (
	mu      sync.RWMutex
	dataDir string
	once    sync.Once
	handle  *sql.DB
	openErr error
)

const ddl = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  account_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
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
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_success ON requests(success);
CREATE INDEX IF NOT EXISTS idx_requests_lookup ON requests(email, account_id, model);
CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id, api_key);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors(ts DESC, id DESC);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  previous_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL,
  messages_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_created_at ON responses(created_at);

CREATE TABLE IF NOT EXISTS backup_entries (
  id                   TEXT PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  kind                 TEXT NOT NULL DEFAULT '',
  note                 TEXT NOT NULL DEFAULT '',
  size                 INTEGER NOT NULL DEFAULT 0,
  sha256               TEXT NOT NULL DEFAULT '',
  account_cnt          INTEGER NOT NULL DEFAULT 0,
  restored_account_cnt INTEGER,
  version              TEXT NOT NULL DEFAULT '',
  format               TEXT NOT NULL DEFAULT '',
  includes_credentials INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_backup_kind_ctime ON backup_entries(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_blobs (
  id   TEXT PRIMARY KEY REFERENCES backup_entries(id) ON DELETE CASCADE,
  data BLOB NOT NULL
);
`

const pragmas = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
`

func Init(dir string) error {
	mu.RLock()
	current := dataDir
	hasHandle := handle != nil
	mu.RUnlock()
	if hasHandle && current != dir {
		if err := Close(); err != nil {
			return err
		}
	}
	mu.Lock()
	dataDir = dir
	mu.Unlock()
	_, err := Get()
	return err
}

func DataDir() string {
	mu.RLock()
	defer mu.RUnlock()
	return dataDir
}

func Path() string {
	return filepath.Join(DataDir(), fileName)
}

func Get() (*sql.DB, error) {
	once.Do(func() {
		dir := DataDir()
		if dir == "" {
			openErr = fmt.Errorf("db: data dir not set, call db.Init first")
			return
		}
		if err := os.MkdirAll(dir, 0700); err != nil {
			openErr = err
			return
		}
		db, err := sql.Open("sqlite", filepath.Join(dir, fileName))
		if err != nil {
			openErr = err
			return
		}
		db.SetMaxOpenConns(1)
		if _, err := db.Exec(pragmas); err != nil {
			_ = db.Close()
			openErr = err
			return
		}
		if _, err := db.Exec(ddl); err != nil {
			_ = db.Close()
			openErr = err
			return
		}
		handle = db
	})
	if openErr != nil {
		return nil, openErr
	}
	if handle == nil {
		return nil, fmt.Errorf("db: handle nil")
	}
	return handle, nil
}

func Close() error {
	mu.Lock()
	defer mu.Unlock()
	var err error
	if handle != nil {
		err = handle.Close()
		handle = nil
	}
	once = sync.Once{}
	openErr = nil
	return err
}

func ResetForTest(dir string) error {
	if err := Close(); err != nil {
		return err
	}
	mu.Lock()
	dataDir = dir
	mu.Unlock()
	_ = os.Remove(filepath.Join(dir, fileName))
	return nil
}

package db

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const fileName = "kiro.db"

var (
	// mu guards every variable here. Get, Read and Close open and close under it, so a Close
	// racing a first Get or Read never leaves a half-made or closed handle behind.
	mu      sync.RWMutex
	dataDir string
	handle  *sql.DB
	openErr error
	// walMode is true once the open handle runs in WAL mode; only then does Read hand out
	// connections of its own.
	walMode bool
	reader  *sql.DB
)

// readConns bounds the read pool: a few admin pages and polls reading at once.
const readConns = 4

// walSwitchWait is how long a start keeps trying to turn an older file to WAL while another
// program holds it.
const walSwitchWait = 5 * time.Second

const ddl = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- accounts holds one row per account, so a change to one account writes its
-- row instead of the whole list. pos orders the list; it may have gaps.
CREATE TABLE IF NOT EXISTS accounts (
  id   TEXT PRIMARY KEY,
  pos  INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  account_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS alert_state (
  key     TEXT PRIMARY KEY,
  period  TEXT NOT NULL DEFAULT '',
  level   INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  channel_id TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  status     INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  event      TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT ''
);

-- The admin's and the user panel's sign-ins, so a restart or a redeploy keeps them
-- (proxy/session_persist.go). token_hash is the SHA-256 of the token the browser
-- holds; the token itself is never stored. kind is 'admin' or 'user'; key_id and
-- key_hash (the key's value at sign-in) are set for 'user' only. expires_at is in
-- Unix milliseconds.
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  key_id     TEXT NOT NULL DEFAULT '',
  key_hash   TEXT NOT NULL DEFAULT '',
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
  message TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_type TEXT NOT NULL DEFAULT '',
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  attempts_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts DESC, id DESC);
-- idx_requests_success_ts below serves every status query; the old one-column index only cost
-- every logged request a write.
DROP INDEX IF EXISTS idx_requests_success;
CREATE INDEX IF NOT EXISTS idx_requests_lookup ON requests(email, account_id, model);
CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id, api_key);
-- A Requests status tab (proxy/observe_persist.go) reads its newest rows in order from this
-- instead of sorting every row of that status, and counts them without reading the table.
-- Each index on requests adds to every logged request's write (about 2 ms while the rollback
-- journal synced its pages), so the other sort columns have none: their pages sort only row ids.
CREATE INDEX IF NOT EXISTS idx_requests_success_ts ON requests(success, ts DESC, id DESC);

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

-- Request bodies kept for replay, compressed, for 30 days and within a size cap.
CREATE TABLE IF NOT EXISTS request_bodies (
  request_id   INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  endpoint     TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  stored_size  INTEGER NOT NULL DEFAULT 0,
  body         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_bodies_created ON request_bodies(created_at);

-- Totals of the requests and errors rows that log retention pruned, so the
-- all-time stats still count them. One row per group the stats read by.
CREATE TABLE IF NOT EXISTS request_rollup (
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

CREATE TABLE IF NOT EXISTS error_rollup (
  model       TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  error_count INTEGER NOT NULL DEFAULT 0,
  last_ts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, account_id)
);

-- The same totals split by the UTC day of the pruned rows (day = ts / 86400),
-- written in the transaction that writes the rollups above, so an all-time
-- chart can still place a pruned row on its day. Rows pruned before these
-- tables existed are only in the rollups above. keyless is 1 for a request
-- that sent no API key and 0 for one whose key matched none (both have an
-- empty api_key_id); the usage by key view tells the two apart.
CREATE TABLE IF NOT EXISTS request_rollup_daily (
  day                INTEGER NOT NULL,
  model              TEXT NOT NULL DEFAULT '',
  account_id         TEXT NOT NULL DEFAULT '',
  api_key_id         TEXT NOT NULL DEFAULT '',
  keyless            INTEGER NOT NULL DEFAULT 0,
  success            INTEGER NOT NULL DEFAULT 0,
  request_count      INTEGER NOT NULL DEFAULT 0,
  in_tokens          INTEGER NOT NULL DEFAULT 0,
  out_tokens         INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  credits            REAL NOT NULL DEFAULT 0,
  last_ts            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, account_id, api_key_id, keyless, success)
);

CREATE TABLE IF NOT EXISTS error_rollup_daily (
  day         INTEGER NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  error_count INTEGER NOT NULL DEFAULT 0,
  last_ts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, account_id)
);
`

// writeParams sets up every writer connection (the driver runs busy_timeout first), so a
// connection database/sql opens again keeps them too. With synchronous=NORMAL a WAL commit
// does not wait for the disk: an app crash or restart loses nothing, and a power cut or a
// host crash can lose the last few seconds of commits, never the file. journal_size_limit
// trims the -wal file back after a checkpoint.
const writeParams = "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_size_limit(67108864)&_pragma=synchronous(1)"

// readParams opens a read connection: query_only refuses any write on it.
const readParams = "?_pragma=busy_timeout(5000)&_pragma=query_only(1)"

func Init(dir string) error {
	mu.RLock()
	current := dataDir
	mu.RUnlock()
	// Another folder starts over: its handles close, and an error from opening the old one
	// (a folder since deleted) is not kept for the new one.
	if current != dir {
		if err := Close(); err != nil {
			return err
		}
	}
	mu.Lock()
	dataDir = dir
	// Init opens a closed database again.
	if handle == nil {
		openErr = nil
	}
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

// Get returns the writer: one connection, so writes never wait on each other's locks.
func Get() (*sql.DB, error) {
	mu.RLock()
	h, err := handle, openErr
	mu.RUnlock()
	if h != nil || err != nil {
		return h, err
	}
	mu.Lock()
	defer mu.Unlock()
	if handle != nil || openErr != nil {
		return handle, openErr
	}
	handle, walMode, openErr = open(dataDir)
	return handle, openErr
}

// open opens the database in dir and brings its schema up to date. It runs under mu.
func open(dir string) (*sql.DB, bool, error) {
	if dir == "" {
		return nil, false, fmt.Errorf("db: data dir not set, call db.Init first")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, false, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, fileName)+writeParams)
	if err != nil {
		return nil, false, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*sql.DB, bool, error) {
		_ = db.Close()
		return nil, false, err
	}
	// WAL lets the read pool (Read) query beside the writer, so an admin search or a usage
	// chart never holds up request logging or a settings save. The mode is kept in the file.
	//! Not fatal: turning an older file to WAL needs it to itself for a moment, and another
	//! program holding it open past busy_timeout (sqlite3, a backup tool) only means this run
	//! keeps the old journal; the next start tries again. A file system without shared memory
	//! (a network share) keeps the old journal too, and Read then hands out the writer.
	//! A retry loop, not busy_timeout alone: SQLite answers SQLITE_BUSY at once, without
	//! waiting, while another connection holds a write lock the switch would deadlock on.
	for deadline := time.Now().Add(walSwitchWait); ; {
		_, err := db.Exec(`PRAGMA journal_mode=WAL`)
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var mode string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		return fail(err)
	}
	if _, err := db.Exec(ddl); err != nil {
		return fail(err)
	}
	if err := addMissingColumns(db, "requests", requestColumnMigrations); err != nil {
		return fail(err)
	}
	//! After the column migration: a table from before conversation_id has no column to index yet.
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_requests_conversation ON requests(conversation_id, ts)`); err != nil {
		return fail(err)
	}
	if err := addMissingColumns(db, "cooldowns", cooldownColumnMigrations); err != nil {
		return fail(err)
	}
	return db, strings.EqualFold(mode, "wal"), nil
}

// requestColumnMigrations lists requests columns added after the first
// release. CREATE TABLE IF NOT EXISTS leaves an older table as it was, so
// addMissingColumns appends them on open.
var requestColumnMigrations = []struct{ name, definition string }{
	{"cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"attempts_json", "TEXT NOT NULL DEFAULT ''"},
	{"request_id", "TEXT NOT NULL DEFAULT ''"},
	// api_key_hash fingerprints a key the proxy did not know, so a search for its full value
	// finds the row even when its mask ("****" for 10 characters or fewer) hides all of it.
	{"api_key_hash", "TEXT NOT NULL DEFAULT ''"},
	// conversation_id groups the turns of one conversation (the session affinity key).
	{"conversation_id", "TEXT NOT NULL DEFAULT ''"},
	// replay_of is the id of the request an admin replayed to make this row; 0 for none.
	{"replay_of", "INTEGER NOT NULL DEFAULT 0"},
	// client is the coding tool that sent the request ("claude-code", "codex"), classified from
	// its User-Agent; the User-Agent itself is never kept.
	{"client", "TEXT NOT NULL DEFAULT ''"},
}

// cooldownColumnMigrations lists cooldowns columns added after the first
// release. An old row gets an empty kind, which self-heal never clears.
var cooldownColumnMigrations = []struct{ name, definition string }{
	{"kind", "TEXT NOT NULL DEFAULT ''"},
}

func addMissingColumns(db *sql.DB, table string, columns []struct{ name, definition string }) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	existing := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		existing[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, column := range columns {
		if existing[column.name] {
			continue
		}
		if _, err := db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
			return fmt.Errorf("add %s.%s: %w", table, column.name, err)
		}
	}
	return nil
}

// Read returns the handle for queries that only read (the request log's pages, search and
// totals, usage charts, conversations). In WAL mode it is a pool of read-only connections
// beside the writer's one, so a slow read never queues request logging or a save behind it;
// a read sees every commit made before it starts. Without WAL it is Get's handle.
func Read() (*sql.DB, error) {
	mu.RLock()
	r := reader
	mu.RUnlock()
	if r != nil {
		return r, nil
	}
	if _, err := Get(); err != nil {
		return nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	if reader != nil {
		return reader, nil
	}
	if handle == nil {
		// Closed again between Get and here.
		return nil, errClosed
	}
	if !walMode {
		reader = handle
		return reader, nil
	}
	r, err := sql.Open("sqlite", filepath.Join(dataDir, fileName)+readParams)
	if err != nil {
		return nil, err
	}
	r.SetMaxOpenConns(readConns)
	r.SetMaxIdleConns(readConns)
	// An idle connection keeps its page cache; a quiet admin gives it back.
	r.SetConnMaxIdleTime(5 * time.Minute)
	reader = r
	return reader, nil
}

// errClosed is what Get and Read return after Close, until Init opens the database again.
var errClosed = errors.New("db: closed")

// Close closes both handles. The read pool closes first, so the writer is the last connection
// and folds the WAL back into the file. Get and Read fail from then on, until Init: a request or
// background job still running at a stop must not open the database again, or the WAL would be
// left beside kiro.db.
func Close() error {
	mu.Lock()
	r, h := reader, handle
	reader, handle, openErr, walMode = nil, nil, errClosed, false
	mu.Unlock()
	var err error
	if r != nil && r != h {
		err = r.Close()
	}
	if h != nil {
		if cerr := h.Close(); err == nil {
			err = cerr
		}
	}
	return err
}

func ResetForTest(dir string) error {
	if err := Close(); err != nil {
		return err
	}
	mu.Lock()
	dataDir, openErr = dir, nil
	mu.Unlock()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(filepath.Join(dir, fileName+suffix))
	}
	return nil
}

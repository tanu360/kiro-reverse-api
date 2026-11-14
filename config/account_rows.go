package config

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// accountRowsBackupNote is the note on the backup saved before the accounts
// move into the accounts table.
const accountRowsBackupNote = "before the accounts moved to their own table"

// storedRow is what one row of the accounts table holds.
type storedRow struct {
	pos  int64
	data string
}

// storedRows mirrors the accounts table, so a save writes only the rows that
// changed. It is nil while the accounts live elsewhere: in cfg.Accounts
// (credLoaded false) or, before migrateAccountRows, in the legacy credentials
// setting. Guarded by credLock.
var storedRows map[string]storedRow

// readAccountRows returns the accounts table in list order.
func readAccountRows() ([]Account, map[string]storedRow, error) {
	d, err := db.Get()
	if err != nil {
		return nil, nil, err
	}
	rows, err := d.Query(`SELECT id, pos, data FROM accounts ORDER BY pos, id`)
	if err != nil {
		return nil, nil, fmt.Errorf("read accounts: %w", err)
	}
	defer rows.Close()
	list := []Account{}
	stored := map[string]storedRow{}
	for rows.Next() {
		var id, data string
		var pos int64
		if err := rows.Scan(&id, &pos, &data); err != nil {
			return nil, nil, fmt.Errorf("read accounts: %w", err)
		}
		var acc Account
		if err := json.Unmarshal([]byte(data), &acc); err != nil {
			return nil, nil, fmt.Errorf("parse account %s: %w", id, err)
		}
		acc.ID = id
		list = append(list, acc)
		stored[id] = storedRow{pos: pos, data: data}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read accounts: %w", err)
	}
	return list, stored, nil
}

// planAccountRows returns the rows list should be stored as. An account keeps
// its stored position while the list order allows it, so removing an account
// or appending one rewrites no other row.
func planAccountRows(list []Account, stored map[string]storedRow) (map[string]storedRow, error) {
	next := make(map[string]storedRow, len(list))
	prev := int64(-1)
	for i := range list {
		id := list[i].ID
		if id == "" {
			return nil, fmt.Errorf("account %d has no id", i+1)
		}
		if _, dup := next[id]; dup {
			return nil, fmt.Errorf("two accounts share the id %s", id)
		}
		data, err := json.Marshal(list[i])
		if err != nil {
			return nil, fmt.Errorf("marshal account %s: %w", id, err)
		}
		pos := prev + 1
		if old, ok := stored[id]; ok && old.pos > prev {
			pos = old.pos
		}
		next[id] = storedRow{pos: pos, data: string(data)}
		prev = pos
	}
	return next, nil
}

// writeAccountRowsTx turns the accounts table from stored into next. With
// stored nil it replaces the whole table and drops the legacy credentials
// setting, whose list the table now holds.
func writeAccountRowsTx(tx *sql.Tx, next, stored map[string]storedRow) error {
	if stored == nil {
		if _, err := tx.Exec(`DELETE FROM accounts`); err != nil {
			return fmt.Errorf("clear accounts: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM settings WHERE key=?`, credentialsKey); err != nil {
			return fmt.Errorf("clear credentials: %w", err)
		}
	}
	for id, row := range next {
		if old, ok := stored[id]; ok && old == row {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO accounts(id, pos, data) VALUES(?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET pos=excluded.pos, data=excluded.data`, id, row.pos, row.data); err != nil {
			return fmt.Errorf("write account %s: %w", id, err)
		}
	}
	for id := range stored {
		if _, ok := next[id]; ok {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM accounts WHERE id=?`, id); err != nil {
			return fmt.Errorf("delete account %s: %w", id, err)
		}
	}
	return nil
}

// saveCredentialsLocked stores credentials, writing only the rows that
// changed. Caller holds credLock for writing.
func saveCredentialsLocked() error {
	next, err := planAccountRows(credentials, storedRows)
	if err != nil {
		return err
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := writeAccountRowsTx(tx, next, storedRows); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	storedRows = next
	return nil
}

// saveCredentialAtLocked stores credentials[i] alone: one row, or none when
// it did not change. Caller holds credLock for writing.
func saveCredentialAtLocked(i int) error {
	acc := &credentials[i]
	old, ok := storedRows[acc.ID]
	if !ok {
		return saveCredentialsLocked()
	}
	data, err := json.Marshal(acc)
	if err != nil {
		return fmt.Errorf("marshal account %s: %w", acc.ID, err)
	}
	if string(data) == old.data {
		return nil
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	if _, err := d.Exec(`UPDATE accounts SET data=? WHERE id=?`, string(data), acc.ID); err != nil {
		return fmt.Errorf("write account %s: %w", acc.ID, err)
	}
	storedRows[acc.ID] = storedRow{pos: old.pos, data: string(data)}
	return nil
}

// withUniqueAccountIDs returns a copy of list in which an account with no id,
// or with the id of an account before it, gets a new one: each row needs its
// own id. A lookup by id always found the first such account, so it keeps it.
func withUniqueAccountIDs(list []Account) []Account {
	out := append([]Account{}, list...)
	seen := make(map[string]bool, len(out))
	for i := range out {
		if out[i].ID == "" || seen[out[i].ID] {
			old := out[i].ID
			out[i].ID = uuid.NewString()
			logger.Warnf("[Accounts] Account %d had the id %q, which is empty or taken; its id is now %s", i+1, old, out[i].ID)
		}
		seen[out[i].ID] = true
	}
	return out
}

// migrateAccountRows moves the accounts into the accounts table, one row per
// account, so a change to one account writes its row instead of the whole
// list. They come from the legacy credentials setting or from cfg.Accounts in
// the config setting. A manual backup is saved first: its format did not
// change, so an older version, which reads neither the table nor this layout,
// can restore it. Afterwards storedRows is set and this does nothing.
func migrateAccountRows() error {
	credLock.RLock()
	done := storedRows != nil
	credLock.RUnlock()
	if done {
		return nil
	}
	if len(GetAccounts()) > 0 {
		if _, err := CreateBackup("manual", accountRowsBackupNote); err != nil {
			return fmt.Errorf("back up accounts: %w", err)
		}
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	credLock.Lock()
	defer credLock.Unlock()
	fromConfig := !credLoaded
	source := credentials
	if fromConfig {
		source = cfg.Accounts
	}
	list := withUniqueAccountIDs(source)
	next, err := planAccountRows(list, nil)
	if err != nil {
		return err
	}

	d, err := db.Get()
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := writeAccountRowsTx(tx, next, nil); err != nil {
		return err
	}
	put := func(key, value string) error {
		_, err := tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
		return err
	}
	if err := put(credentialsLoadedKey, "1"); err != nil {
		return fmt.Errorf("write credentials flag: %w", err)
	}
	if fromConfig {
		moved := *cfg
		moved.Accounts = []Account{}
		data, err := json.Marshal(moved)
		if err != nil {
			return err
		}
		if err := put("config", string(data)); err != nil {
			return fmt.Errorf("write config: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	if fromConfig {
		cfg.Accounts = []Account{}
	}
	credentials, credLoaded, storedRows = list, true, next
	if len(list) > 0 {
		logger.Infof("[Accounts] Moved %d accounts to their own table, one row each", len(list))
	}
	return nil
}

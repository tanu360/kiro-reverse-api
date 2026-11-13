package pool

import (
	"sync"
	"time"

	"kiro-proxy/db"
	"kiro-proxy/logger"
	"kiro-proxy/textfmt"
)

// backgroundSavesRunning counts the cooldown saves started by
// saveCooldownsInBackground that have not finished yet.
var (
	backgroundSavesMu      sync.Mutex
	backgroundSavesIdle    = sync.NewCond(&backgroundSavesMu)
	backgroundSavesRunning int
)

// saveCooldownsInBackground saves the cooldowns without making the request
// that set them wait for the database.
func (p *AccountPool) saveCooldownsInBackground() {
	backgroundSavesMu.Lock()
	backgroundSavesRunning++
	backgroundSavesMu.Unlock()
	go func() {
		defer func() {
			backgroundSavesMu.Lock()
			backgroundSavesRunning--
			if backgroundSavesRunning == 0 {
				backgroundSavesIdle.Broadcast()
			}
			backgroundSavesMu.Unlock()
		}()
		_ = p.SaveCooldowns()
	}()
}

// WaitForBackgroundSaves returns once every cooldown save started in the
// background has finished. Tests call it before their data folder is removed:
// a save still running would write a journal file into the folder while it is
// being deleted.
func WaitForBackgroundSaves() {
	backgroundSavesMu.Lock()
	defer backgroundSavesMu.Unlock()
	for backgroundSavesRunning > 0 {
		backgroundSavesIdle.Wait()
	}
}

func (p *AccountPool) SaveCooldowns() error {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	now := time.Now()
	type kv struct {
		id   string
		exp  int64
		kind CooldownKind
	}
	active := make([]kv, 0, len(p.cooldowns))
	for id, t := range p.cooldowns {
		if t.After(now) {
			active = append(active, kv{id, t.Unix(), p.cooldownKinds[id]})
		}
	}
	p.mu.RUnlock()

	d, err := db.Get()
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM cooldowns`); err != nil {
		return err
	}
	if len(active) > 0 {
		stmt, err := tx.Prepare(`INSERT INTO cooldowns(account_id, expires_at, kind) VALUES(?, ?, ?)`)
		if err != nil {
			return err
		}
		for _, kv := range active {
			if _, err := stmt.Exec(kv.id, kv.exp, string(kv.kind)); err != nil {
				stmt.Close()
				return err
			}
		}
		stmt.Close()
	}
	return tx.Commit()
}

func (p *AccountPool) loadCooldowns() error {
	if p == nil {
		return nil
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	rows, err := d.Query(`SELECT account_id, expires_at, kind FROM cooldowns WHERE expires_at > ?`, now)
	if err != nil {
		return err
	}
	defer rows.Close()

	p.mu.Lock()
	defer p.mu.Unlock()

	loaded := 0
	for rows.Next() {
		var id, kind string
		var exp int64
		if err := rows.Scan(&id, &exp, &kind); err != nil {
			return err
		}
		p.cooldowns[id] = time.Unix(exp, 0)
		p.setKindLocked(id, CooldownKind(kind))
		loaded++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if loaded > 0 {
		logger.Infof("[Pool] Loaded %s from the database", textfmt.Count(loaded, "active cooldown", "active cooldowns"))
	}
	return nil
}

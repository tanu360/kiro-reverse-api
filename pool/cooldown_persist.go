package pool

import (
	"time"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

func (p *AccountPool) SaveCooldowns() error {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	now := time.Now()
	type kv struct {
		id  string
		exp int64
	}
	active := make([]kv, 0, len(p.cooldowns))
	for id, t := range p.cooldowns {
		if t.After(now) {
			active = append(active, kv{id, t.Unix()})
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
		stmt, err := tx.Prepare(`INSERT INTO cooldowns(account_id, expires_at) VALUES(?, ?)`)
		if err != nil {
			return err
		}
		for _, kv := range active {
			if _, err := stmt.Exec(kv.id, kv.exp); err != nil {
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
	rows, err := d.Query(`SELECT account_id, expires_at FROM cooldowns WHERE expires_at > ?`, now)
	if err != nil {
		return err
	}
	defer rows.Close()

	p.mu.Lock()
	defer p.mu.Unlock()

	loaded := 0
	for rows.Next() {
		var id string
		var exp int64
		if err := rows.Scan(&id, &exp); err != nil {
			return err
		}
		p.cooldowns[id] = time.Unix(exp, 0)
		loaded++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if loaded > 0 {
		logger.Infof("[Pool] Loaded %d active cooldowns from db", loaded)
	}
	return nil
}

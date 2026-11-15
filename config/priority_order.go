package config

import (
	"encoding/json"
	"fmt"

	"kiro-proxy/db"
	"kiro-proxy/logger"
)

// higherFirstPriorities returns accounts with priorities saved when a lower
// number went first turned into the current order, higher first: each becomes
// the highest old priority minus its own, so the order stays the same and the
// old first (0) becomes the highest. When every priority is 0 there is no
// order to keep and accounts comes back as it is. changed counts the accounts
// whose priority moved. accounts itself is never written.
func higherFirstPriorities(accounts []Account) (out []Account, changed int) {
	highest := 0
	for i := range accounts {
		highest = max(highest, accounts[i].Priority)
	}
	if highest == 0 {
		return accounts, 0
	}
	out = append([]Account(nil), accounts...)
	for i := range out {
		//! Clamped for a hand-edited negative priority, which the admin API never accepts.
		next := min(max(highest-out[i].Priority, 0), MaxAccountPriority)
		if next != out[i].Priority {
			out[i].Priority = next
			changed++
		}
	}
	return out, changed
}

// migratePriorityOrder turns the stored account priorities around once, for a
// config saved when a lower number went first (higherFirstPriorities), and
// records in the config that it ran, so it never runs again. A new config is
// created with the mark. The accounts and the mark are written in one
// transaction: running it twice would put the old order back.
func migratePriorityOrder() error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg.PriorityHigherFirst {
		return nil
	}
	credLock.Lock()
	defer credLock.Unlock()

	source := cfg.Accounts
	if credLoaded {
		source = credentials
	}
	list, changed := higherFirstPriorities(source)

	marked := *cfg
	marked.PriorityHigherFirst = true
	if !credLoaded {
		marked.Accounts = list
	}
	configData, err := json.Marshal(marked)
	if err != nil {
		return err
	}
	var next map[string]storedRow
	if credLoaded && changed > 0 && storedRows != nil {
		if next, err = planAccountRows(list, storedRows); err != nil {
			return err
		}
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
	put := func(key, value string) error {
		_, err := tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
		return err
	}
	if err := put("config", string(configData)); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if credLoaded && changed > 0 {
		if storedRows != nil {
			if err := writeAccountRowsTx(tx, next, storedRows); err != nil {
				return err
			}
		} else {
			//! The accounts are still in the legacy setting (migrateAccountRows failed); they stay there.
			data, err := json.Marshal(list)
			if err != nil {
				return err
			}
			if err := put(credentialsKey, string(data)); err != nil {
				return fmt.Errorf("write credentials: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	cfg.PriorityHigherFirst = true
	if !credLoaded {
		cfg.Accounts = list
	} else if changed > 0 {
		credentials = list
		if storedRows != nil {
			storedRows = next
		}
	}
	if changed > 0 {
		logger.Infof("[Accounts] Account priorities now go higher first; turned around %d saved priorities so the accounts keep their order", changed)
	}
	return nil
}

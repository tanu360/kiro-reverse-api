package config

import (
	"database/sql"
	"errors"

	"kiro-proxy/db"
)

func getSetting(key string) (string, bool, error) {
	d, err := db.Get()
	if err != nil {
		return "", false, err
	}
	var v string
	err = d.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

func setSetting(key, value string) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO settings(key,value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func deleteSetting(key string) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM settings WHERE key=?`, key)
	return err
}

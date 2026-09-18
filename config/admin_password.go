package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
)

// MinAdminPasswordLength is the shortest admin password the settings API accepts.
const MinAdminPasswordLength = 8

func generateAdminPassword() (string, error) {
	secret, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		return "", fmt.Errorf("generate admin password: %w", err)
	}
	return fmt.Sprintf("%08d", secret.Int64()), nil
}

// Only replace an unclaimed password produced by the former 24-byte generator.
func shortenPendingAdminPasswordLocked() (bool, error) {
	if !cfg.FirstRunPasswordPending || os.Getenv("ADMIN_PASSWORD") != "" || len(cfg.Password) != 48 {
		return false, nil
	}
	if _, err := hex.DecodeString(cfg.Password); err != nil {
		return false, nil
	}
	password, err := generateAdminPassword()
	if err != nil {
		return false, err
	}
	previous := cfg.Password
	cfg.Password = password
	if err := saveLocked(); err != nil {
		cfg.Password = previous
		return false, err
	}
	return true, nil
}

// FirstRunPassword returns the generated admin password while nobody has signed
// in with it yet, and "" afterwards. The login page is public, so the password
// stays visible there only until its owner has used it once.
func FirstRunPassword() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || !cfg.FirstRunPasswordPending {
		return ""
	}
	return cfg.Password
}

// ClearFirstRunPassword stops the login page from showing the generated password.
func ClearFirstRunPassword() error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil || !cfg.FirstRunPasswordPending {
		return nil
	}
	cfg.FirstRunPasswordPending = false
	return saveLocked()
}

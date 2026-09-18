package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// MinAdminPasswordLength is the shortest admin password the settings API accepts.
const MinAdminPasswordLength = 8

func generateAdminPassword() (string, error) {
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", fmt.Errorf("generate admin password: %w", err)
	}
	return hex.EncodeToString(secret[:]), nil
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

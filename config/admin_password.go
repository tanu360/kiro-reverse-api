package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// minStrongAdminPasswordLength is the shortest password that does not raise the
// weak-credential warning surfaced by the admin UI.
const minStrongAdminPasswordLength = 16

// shippedAdminPasswords are the defaults older releases wrote into the database.
// They are public knowledge, so an install still carrying one has no password at
// all in practice and is rotated on boot.
var shippedAdminPasswords = map[string]bool{
	"changeme": true,
	"admin":    true,
	"password": true,
	"kiro":     true,
	"123456":   true,
}

func generateAdminPassword() (string, error) {
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", fmt.Errorf("generate admin password: %w", err)
	}
	return hex.EncodeToString(secret[:]), nil
}

// IsShippedAdminPassword reports whether a password is one this project once
// shipped as a default.
func IsShippedAdminPassword(password string) bool {
	return shippedAdminPasswords[strings.ToLower(strings.TrimSpace(password))]
}

// IsWeakAdminPassword reports a password worth warning about but never worth
// rotating on the operator's behalf. Rotating a credential someone chose would
// lock them out of their own install, and the only recovery is a log line they
// may never read, so short passwords are reported and left alone.
func IsWeakAdminPassword(password string) bool {
	return len(strings.TrimSpace(password)) < minStrongAdminPasswordLength
}

// AdminPasswordRotated reports whether this boot replaced a shipped default
// password. The admin UI turns it into a one-time banner telling the operator
// where to find the new credential.
func AdminPasswordRotated() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return adminPasswordRotated
}

// AdminPasswordWeak reports whether the active password is shorter than
// minStrongAdminPasswordLength.
func AdminPasswordWeak() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return IsWeakAdminPassword(cfg.Password)
}

// migrateAdminPasswordLocked rotates a shipped default password away on boot.
// The caller must hold cfgLock for writing.
func migrateAdminPasswordLocked() error {
	adminPasswordRotated = false
	if cfg == nil || !IsShippedAdminPassword(cfg.Password) {
		return nil
	}
	//! An explicit ADMIN_PASSWORD is the operator speaking; main applies it after Load.
	if strings.TrimSpace(os.Getenv("ADMIN_PASSWORD")) != "" {
		return nil
	}
	password, err := generateAdminPassword()
	if err != nil {
		return err
	}
	cfg.Password = password
	if err := saveLocked(); err != nil {
		return err
	}
	adminPasswordRotated = true
	return nil
}

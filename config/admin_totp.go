package config

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"os"
	"strconv"
	"strings"

	"kiro-proxy/logger"
)

// ResetAdminTOTPEnv names the lockout escape: set to a true value, the server
// turns admin two-factor sign-in off when it starts.
const ResetAdminTOTPEnv = "ADMIN_RESET_2FA"

// adminTOTPStepKey holds the last time step a code signed in with, so a code
// works once. It changes on every sign-in, so it stays out of the config row:
// config.Save snapshots a backup first.
const adminTOTPStepKey = "admin_totp_last_step"

// AdminTOTPStatus is what the settings page shows about two-factor sign-in.
type AdminTOTPStatus struct {
	Enabled       bool  `json:"enabled"`
	EnabledAt     int64 `json:"enabledAt,omitempty"`
	RecoveryCodes int   `json:"recoveryCodesLeft"`
	// ResetByEnv is true while ADMIN_RESET_2FA is set: every start turns it off again.
	ResetByEnv bool `json:"resetByEnv"`
}

// AdminTOTPResetRequested reports whether ADMIN_RESET_2FA holds a true value.
func AdminTOTPResetRequested() bool {
	raw := strings.TrimSpace(os.Getenv(ResetAdminTOTPEnv))
	if raw == "" {
		return false
	}
	on, err := strconv.ParseBool(raw)
	return err == nil && on || strings.EqualFold(raw, "yes") || strings.EqualFold(raw, "on")
}

func resetAdminTOTPIfAsked() error {
	if !AdminTOTPResetRequested() {
		return nil
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil || cfg.AdminTOTPSecret == "" {
		logger.Warnf("[Admin] %s is set but two-factor sign-in is already off; remove it from the environment", ResetAdminTOTPEnv)
		return nil
	}
	clearAdminTOTPLocked()
	if err := saveLocked(); err != nil {
		return err
	}
	_ = deleteSetting(adminTOTPStepKey)
	logger.Warnf("[Admin] Two-factor sign-in was turned off by %s; sign in with the password, then remove %s from the environment", ResetAdminTOTPEnv, ResetAdminTOTPEnv)
	return nil
}

func clearAdminTOTPLocked() {
	cfg.AdminTOTPSecret = ""
	cfg.AdminTOTPRecovery = nil
	cfg.AdminTOTPEnabledAt = 0
}

// GetAdminTOTPSecret is the enrolled secret, or "" while two-factor sign-in is off.
func GetAdminTOTPSecret() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return ""
	}
	return cfg.AdminTOTPSecret
}

// AdminTOTPEnabled reports whether sign-in asks for a code after the password.
func AdminTOTPEnabled() bool {
	return GetAdminTOTPSecret() != ""
}

// GetAdminTOTPStatus is two-factor sign-in's state, without the secret.
func GetAdminTOTPStatus() AdminTOTPStatus {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	status := AdminTOTPStatus{ResetByEnv: AdminTOTPResetRequested()}
	if cfg == nil || cfg.AdminTOTPSecret == "" {
		return status
	}
	status.Enabled = true
	status.EnabledAt = cfg.AdminTOTPEnabledAt
	status.RecoveryCodes = len(cfg.AdminTOTPRecovery)
	return status
}

// HashRecoveryCode is how a recovery code is stored: SHA-256 of its letters and
// digits in lower case, so "ABCDE-12345" and "abcde12345" are one code.
func HashRecoveryCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(code) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return ""
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// EnableAdminTOTP turns two-factor sign-in on with secret and the hashes of fresh
// recovery codes. step is the step of the code that confirmed it, used up here.
func EnableAdminTOTP(secret string, recoveryHashes []string, enabledAt, step int64) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.AdminTOTPSecret = secret
	cfg.AdminTOTPRecovery = append([]string(nil), recoveryHashes...)
	cfg.AdminTOTPEnabledAt = enabledAt
	if err := Save(); err != nil {
		clearAdminTOTPLocked()
		return err
	}
	return setSetting(adminTOTPStepKey, strconv.FormatInt(step, 10))
}

// DisableAdminTOTP turns two-factor sign-in off and forgets the secret and codes.
func DisableAdminTOTP() error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	clearAdminTOTPLocked()
	if err := Save(); err != nil {
		return err
	}
	return deleteSetting(adminTOTPStepKey)
}

// ReplaceAdminTOTPRecovery swaps the recovery codes for a fresh set.
func ReplaceAdminTOTPRecovery(recoveryHashes []string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg.AdminTOTPSecret == "" {
		return nil
	}
	cfg.AdminTOTPRecovery = append([]string(nil), recoveryHashes...)
	return Save()
}

// ConsumeAdminTOTPRecovery uses up a recovery code: true when it was one of the
// unused codes, which is then gone. Every stored hash is compared.
func ConsumeAdminTOTPRecovery(code string) (bool, error) {
	hash := HashRecoveryCode(code)
	if hash == "" {
		return false, nil
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg.AdminTOTPSecret == "" {
		return false, nil
	}
	index := -1
	for i, stored := range cfg.AdminTOTPRecovery {
		if subtle.ConstantTimeCompare([]byte(stored), []byte(hash)) == 1 && index < 0 {
			index = i
		}
	}
	if index < 0 {
		return false, nil
	}
	previous := cfg.AdminTOTPRecovery
	kept := make([]string, 0, len(previous)-1)
	kept = append(kept, previous[:index]...)
	kept = append(kept, previous[index+1:]...)
	cfg.AdminTOTPRecovery = kept
	if err := saveLocked(); err != nil {
		cfg.AdminTOTPRecovery = previous
		return false, err
	}
	return true, nil
}

// AdminTOTPLastStep is the last time step a code was accepted for; 0 when none.
func AdminTOTPLastStep() (int64, error) {
	raw, ok, err := getSetting(adminTOTPStepKey)
	if err != nil || !ok {
		return 0, err
	}
	step, _ := strconv.ParseInt(raw, 10, 64)
	return step, nil
}

// SetAdminTOTPLastStep records the step of a code just accepted.
func SetAdminTOTPLastStep(step int64) error {
	return setSetting(adminTOTPStepKey, strconv.FormatInt(step, 10))
}

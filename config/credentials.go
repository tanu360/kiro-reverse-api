// Package config: credential storage and writeback
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var (
	credPath    string
	credLock    sync.RWMutex
	credentials []Account
	credLoaded  bool
)

// InitCredentials sets the credentials file path (called from Init)
func InitCredentials(configDir string) {
	credPath = filepath.Join(configDir, "credentials.json")
}

// LoadCredentials loads credentials from credentials.json
// Supports both single-object format (legacy) and array format (multi-credential)
// Returns nil if file doesn't exist (not an error)
func LoadCredentials() error {
	credLock.Lock()
	defer credLock.Unlock()

	data, err := os.ReadFile(credPath)
	if err != nil {
		if os.IsNotExist(err) {
			credentials = []Account{}
			credLoaded = false
			return nil
		}
		return fmt.Errorf("read credentials.json: %w", err)
	}

	// Try array format first
	var arr []Account
	if err := json.Unmarshal(data, &arr); err == nil {
		credentials = arr
		credLoaded = true
		return nil
	}

	// Fallback to single-object format (legacy)
	var single Account
	if err := json.Unmarshal(data, &single); err != nil {
		return fmt.Errorf("parse credentials.json (neither array nor object): %w", err)
	}

	credentials = []Account{single}
	credLoaded = true
	return nil
}

// SaveCredentials writes credentials to credentials.json (array format)
// Atomic write: tmp file + rename
func SaveCredentials() error {
	credLock.RLock()
	data, err := json.MarshalIndent(credentials, "", "  ")
	credLock.RUnlock()
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}

	// Atomic write: tmp + rename
	tmpPath := credPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("write tmp credentials: %w", err)
	}
	if err := os.Rename(tmpPath, credPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename credentials: %w", err)
	}
	return nil
}

// CredentialsSnapshot returns a copy of the current credentials state.
func CredentialsSnapshot() (bool, []Account) {
	credLock.RLock()
	defer credLock.RUnlock()
	result := make([]Account, len(credentials))
	copy(result, credentials)
	return credLoaded, result
}

// ReplaceCredentials atomically replaces the credentials file and in-memory state.
func ReplaceCredentials(loaded bool, accounts []Account) error {
	snapshot := make([]Account, len(accounts))
	copy(snapshot, accounts)

	if loaded {
		if err := writeCredentialsSnapshot(snapshot); err != nil {
			return err
		}
	} else if credPath != "" {
		if err := os.Remove(credPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove credentials: %w", err)
		}
	}

	credLock.Lock()
	credentials = snapshot
	credLoaded = loaded
	credLock.Unlock()
	return nil
}

func writeCredentialsSnapshot(snapshot []Account) error {
	if credPath == "" {
		return fmt.Errorf("credentials path not initialized")
	}
	if err := os.MkdirAll(filepath.Dir(credPath), 0700); err != nil {
		return fmt.Errorf("create credentials dir: %w", err)
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	tmpPath := credPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("write tmp credentials: %w", err)
	}
	if err := os.Rename(tmpPath, credPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename credentials: %w", err)
	}
	return nil
}

// GetCredentials returns a copy of all credentials
func GetCredentials() []Account {
	credLock.RLock()
	defer credLock.RUnlock()
	if !credLoaded {
		return nil
	}
	result := make([]Account, len(credentials))
	copy(result, credentials)
	return result
}

// GetCredentialByID returns a credential by ID
func GetCredentialByID(id string) *Account {
	credLock.RLock()
	defer credLock.RUnlock()
	for i := range credentials {
		if credentials[i].ID == id {
			acc := credentials[i]
			return &acc
		}
	}
	return nil
}

// UpdateCredentialToken updates token fields and writes back to credentials.json
func UpdateCredentialToken(id, accessToken, refreshToken string, expiresAt int64) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].AccessToken = accessToken
			if refreshToken != "" {
				credentials[i].RefreshToken = refreshToken
			}
			credentials[i].ExpiresAt = expiresAt
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

// UpdateCredentialInfo updates account info fields
func UpdateCredentialInfo(id string, info AccountInfo) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].SubscriptionType = info.SubscriptionType
			credentials[i].SubscriptionTitle = info.SubscriptionTitle
			credentials[i].DaysRemaining = info.DaysRemaining
			credentials[i].UsageCurrent = info.UsageCurrent
			credentials[i].UsageLimit = info.UsageLimit
			credentials[i].UsagePercent = info.UsagePercent
			credentials[i].NextResetDate = info.NextResetDate
			credentials[i].LastRefresh = info.LastRefresh
			credentials[i].TrialUsageCurrent = info.TrialUsageCurrent
			credentials[i].TrialUsageLimit = info.TrialUsageLimit
			credentials[i].TrialUsagePercent = info.TrialUsagePercent
			credentials[i].TrialStatus = info.TrialStatus
			credentials[i].TrialExpiresAt = info.TrialExpiresAt
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

// UpdateCredentialStats updates runtime statistics
func UpdateCredentialStats(id string, requestCount, errorCount, totalTokens int, totalCredits float64, lastUsed int64) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].RequestCount = requestCount
			credentials[i].ErrorCount = errorCount
			credentials[i].TotalTokens = totalTokens
			credentials[i].TotalCredits = totalCredits
			credentials[i].LastUsed = lastUsed
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

// UpdateCredentialProfileArn updates ProfileArn field
func UpdateCredentialProfileArn(id, profileArn string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].ProfileArn = profileArn
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

// AddCredential adds a new credential
func AddCredential(acc Account) error {
	credLock.Lock()
	defer credLock.Unlock()
	credentials = append(credentials, acc)
	credLoaded = true
	credLock.Unlock()
	err := SaveCredentials()
	credLock.Lock()
	return err
}

// RemoveCredential removes a credential by ID
func RemoveCredential(id string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials = append(credentials[:i], credentials[i+1:]...)
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

// UpdateCredential updates an entire credential entry
func UpdateCredential(acc Account) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == acc.ID {
			credentials[i] = acc
			credLock.Unlock()
			err := SaveCredentials()
			credLock.Lock()
			return err
		}
	}
	return fmt.Errorf("credential not found: %s", acc.ID)
}

// CredentialsLoaded returns whether credentials.json was successfully loaded
func CredentialsLoaded() bool {
	credLock.RLock()
	defer credLock.RUnlock()
	return credLoaded
}

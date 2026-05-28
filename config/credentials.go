package config

import (
	"encoding/json"
	"fmt"
	"sync"
)

const credentialsKey = "credentials"
const credentialsLoadedKey = "credentials_loaded"

var (
	credLock    sync.RWMutex
	credentials []Account
	credLoaded  bool
)

func LoadCredentials() error {
	credLock.Lock()
	defer credLock.Unlock()

	raw, ok, err := getSetting(credentialsKey)
	if err != nil {
		return fmt.Errorf("read credentials: %w", err)
	}
	loadedRaw, _, _ := getSetting(credentialsLoadedKey)

	if !ok {
		credentials = []Account{}
		credLoaded = loadedRaw == "1"
		return nil
	}

	var arr []Account
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return fmt.Errorf("parse credentials: %w", err)
	}
	credentials = arr
	if loadedRaw == "" {
		// If a credentials row exists without a flag, treat it as loaded.
		credLoaded = len(arr) > 0
	} else {
		credLoaded = loadedRaw == "1"
	}
	return nil
}

func SaveCredentials() error {
	credLock.RLock()
	data, err := json.Marshal(credentials)
	credLock.RUnlock()
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	if err := setSetting(credentialsKey, string(data)); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	return nil
}

func CredentialsSnapshot() (bool, []Account) {
	credLock.RLock()
	defer credLock.RUnlock()
	result := make([]Account, len(credentials))
	copy(result, credentials)
	return credLoaded, result
}

func ReplaceCredentials(loaded bool, accounts []Account) error {
	snapshot := make([]Account, len(accounts))
	copy(snapshot, accounts)

	if loaded {
		data, err := json.Marshal(snapshot)
		if err != nil {
			return fmt.Errorf("marshal credentials: %w", err)
		}
		if err := setSetting(credentialsKey, string(data)); err != nil {
			return fmt.Errorf("write credentials: %w", err)
		}
		if err := setSetting(credentialsLoadedKey, "1"); err != nil {
			return fmt.Errorf("write credentials flag: %w", err)
		}
	} else {
		if err := deleteSetting(credentialsKey); err != nil {
			return fmt.Errorf("clear credentials: %w", err)
		}
		if err := setSetting(credentialsLoadedKey, "0"); err != nil {
			return fmt.Errorf("write credentials flag: %w", err)
		}
	}

	credLock.Lock()
	credentials = snapshot
	credLoaded = loaded
	credLock.Unlock()
	return nil
}

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

func saveCredentialsLocked() error {
	data, err := json.Marshal(credentials)
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	return setSetting(credentialsKey, string(data))
}

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
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

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
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

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
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func UpdateCredentialProfileArn(id, profileArn string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].ProfileArn = profileArn
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func UpdateCredentialOverageStatus(id, status, capability string, cap, rate, current float64, checkedAt int64) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			if status != "" {
				credentials[i].OverageStatus = status
			}
			if capability != "" {
				credentials[i].OverageCapability = capability
			}
			credentials[i].OverageCap = cap
			credentials[i].OverageRate = rate
			credentials[i].CurrentOverages = current
			if checkedAt > 0 {
				credentials[i].OverageCheckedAt = checkedAt
			}
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func AddCredential(acc Account) error {
	credLock.Lock()
	defer credLock.Unlock()
	credentials = append(credentials, acc)
	credLoaded = true
	if err := setSetting(credentialsLoadedKey, "1"); err != nil {
		return err
	}
	return saveCredentialsLocked()
}

func RemoveCredential(id string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials = append(credentials[:i], credentials[i+1:]...)
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func UpdateCredential(acc Account) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == acc.ID {
			credentials[i] = acc
			return saveCredentialsLocked()
		}
	}
	return fmt.Errorf("credential not found: %s", acc.ID)
}

func CredentialsLoaded() bool {
	credLock.RLock()
	defer credLock.RUnlock()
	return credLoaded
}

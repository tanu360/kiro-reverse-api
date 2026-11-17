package config

import (
	"encoding/json"
	"fmt"
	"sync"

	"kiro-proxy/db"
)

// credentialsKey is the legacy setting that held the whole account list as one
// JSON value. The accounts table replaced it; migrateAccountRows moves it there.
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

	loadedRaw, _, err := getSetting(credentialsLoadedKey)
	if err != nil {
		return fmt.Errorf("read credentials flag: %w", err)
	}
	credentials, credLoaded, storedRows = []Account{}, loadedRaw == "1", nil
	if !credLoaded {
		return nil
	}

	//! A legacy list wins over the table: an older version wrote it last. migrateAccountRows moves it.
	raw, ok, err := getSetting(credentialsKey)
	if err != nil {
		return fmt.Errorf("read credentials: %w", err)
	}
	if ok {
		var arr []Account
		if err := json.Unmarshal([]byte(raw), &arr); err != nil {
			return fmt.Errorf("parse credentials: %w", err)
		}
		credentials = arr
		return nil
	}

	list, stored, err := readAccountRows()
	if err != nil {
		return err
	}
	credentials, storedRows = list, stored
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
	credLock.Lock()
	defer credLock.Unlock()
	snapshot := make([]Account, len(accounts))
	copy(snapshot, accounts)

	var next map[string]storedRow
	if loaded {
		var err error
		if next, err = planAccountRows(snapshot, nil); err != nil {
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
	if err := writeAccountRowsTx(tx, next, nil); err != nil {
		return err
	}
	flag := "0"
	if loaded {
		flag = "1"
	}
	if _, err := tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, credentialsLoadedKey, flag); err != nil {
		return fmt.Errorf("write credentials flag: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	credentials = snapshot
	credLoaded = loaded
	storedRows = next
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
			return saveCredentialAtLocked(i)
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
			credentials[i].NextResetAt = info.NextResetAt
			credentials[i].LastRefresh = info.LastRefresh
			credentials[i].TrialUsageCurrent = info.TrialUsageCurrent
			credentials[i].TrialUsageLimit = info.TrialUsageLimit
			credentials[i].TrialUsagePercent = info.TrialUsagePercent
			credentials[i].TrialStatus = info.TrialStatus
			credentials[i].TrialExpiresAt = info.TrialExpiresAt
			return saveCredentialAtLocked(i)
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
			return saveCredentialAtLocked(i)
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func UpdateCredentialProfileArn(id, profileArn string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			if credentials[i].ProfileArnPinned {
				return nil
			}
			credentials[i].ProfileArn = profileArn
			return saveCredentialAtLocked(i)
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func PinCredentialProfileArn(id, profileArn string) error {
	credLock.Lock()
	defer credLock.Unlock()
	for i := range credentials {
		if credentials[i].ID == id {
			credentials[i].ProfileArn = profileArn
			credentials[i].ProfileArnPinned = profileArn != ""
			return saveCredentialAtLocked(i)
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
			return saveCredentialAtLocked(i)
		}
	}
	return fmt.Errorf("credential not found: %s", id)
}

func AddCredential(acc Account) error {
	credLock.Lock()
	defer credLock.Unlock()
	if hasKiroAPIKey(credentials, acc.KiroApiKey) {
		return ErrDuplicateKiroAPIKey
	}
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
			preserveAccountCredentials(&acc, credentials[i])
			preserveAccountMetadata(&acc, credentials[i])
			credentials[i] = acc
			return saveCredentialAtLocked(i)
		}
	}
	return fmt.Errorf("credential not found: %s", acc.ID)
}

func CredentialsLoaded() bool {
	credLock.RLock()
	defer credLock.RUnlock()
	return credLoaded
}

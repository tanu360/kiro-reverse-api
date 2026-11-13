package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// ErrApiKeyLockout refuses a change that would leave a proxy that requires API
// keys with no enabled key, so every client would get 401.
var ErrApiKeyLockout = errors.New("would lock out every client")

// API key errors the admin API reports with a code.
var (
	ErrApiKeyNotFound      = errors.New("api key not found")
	ErrApiKeyEmpty         = errors.New("api key value must not be empty")
	ErrApiKeyExists        = errors.New("api key already exists")
	ErrApiKeyCollision     = errors.New("api key value collides with existing entry")
	ErrTokenLimitNegative  = errors.New("token limit must be zero or positive")
	ErrCreditLimitNegative = errors.New("credit limit must be zero or positive")
)

func ListApiKeys() []ApiKeyEntry {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return nil
	}
	out := make([]ApiKeyEntry, len(cfg.ApiKeys))
	copy(out, cfg.ApiKeys)
	return out
}

func GetApiKeyEntry(id string) *ApiKeyEntry {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return nil
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID == id {
			cp := cfg.ApiKeys[i]
			return &cp
		}
	}
	return nil
}

func AddApiKey(entry ApiKeyEntry) (ApiKeyEntry, error) {
	credIDs := credentialAccountIDs()
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return ApiKeyEntry{}, errors.New("config not initialized")
	}
	entry.Name = strings.TrimSpace(entry.Name)
	entry.Key = strings.TrimSpace(entry.Key)
	if entry.Key == "" {
		return ApiKeyEntry{}, ErrApiKeyEmpty
	}
	if err := validateApiKeyLimits(entry.TokenLimit, entry.CreditLimit); err != nil {
		return ApiKeyEntry{}, err
	}
	if err := validateApiKeyCallLimit(entry.CallLimit); err != nil {
		return ApiKeyEntry{}, err
	}
	accountIDs, err := normalizeApiKeyAccountIDsLocked(entry.AccountIDs, nil, credIDs)
	if err != nil {
		return ApiKeyEntry{}, err
	}
	entry.AccountIDs = accountIDs
	for _, existing := range cfg.ApiKeys {
		if existing.Key == entry.Key {
			return ApiKeyEntry{}, ErrApiKeyExists
		}
	}
	if entry.ID == "" {
		entry.ID = GenerateMachineId()
	}
	if entry.CreatedAt == 0 {
		entry.CreatedAt = time.Now().Unix()
	}
	cfg.ApiKeys = append(cfg.ApiKeys, entry)
	if err := Save(); err != nil {
		cfg.ApiKeys = cfg.ApiKeys[:len(cfg.ApiKeys)-1]
		return ApiKeyEntry{}, err
	}
	return entry, nil
}

func UpdateApiKey(id string, patch ApiKeyEntry) error {
	return updateApiKey(id, patch, false)
}

// UpdateApiKeyGuarded is UpdateApiKey that returns ErrApiKeyLockout instead of
// disabling the last enabled key while keys are required. The check and the
// write share one lock, so two concurrent changes cannot both pass it.
func UpdateApiKeyGuarded(id string, patch ApiKeyEntry) error {
	return updateApiKey(id, patch, true)
}

func updateApiKey(id string, patch ApiKeyEntry, guard bool) error {
	credIDs := credentialAccountIDs()
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	idx := -1
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrApiKeyNotFound
	}
	if guard && !patch.Enabled && removingKeyLocksOutLocked(cfg.ApiKeys[idx]) {
		return ErrApiKeyLockout
	}
	if err := validateApiKeyLimits(patch.TokenLimit, patch.CreditLimit); err != nil {
		return err
	}
	if err := validateApiKeyCallLimit(patch.CallLimit); err != nil {
		return err
	}
	accountIDs, err := normalizeApiKeyAccountIDsLocked(patch.AccountIDs, cfg.ApiKeys[idx].AccountIDs, credIDs)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(patch.Name)
	newKey := ""
	if patch.Key != "" {
		newKey = strings.TrimSpace(patch.Key)
		if newKey == "" {
			return ErrApiKeyEmpty
		}
		for j := range cfg.ApiKeys {
			if j != idx && cfg.ApiKeys[j].Key == newKey {
				return ErrApiKeyCollision
			}
		}
	}

	cfg.ApiKeys[idx].Name = name
	if newKey != "" {
		cfg.ApiKeys[idx].Key = newKey
	}
	cfg.ApiKeys[idx].Enabled = patch.Enabled
	cfg.ApiKeys[idx].TokenLimit = patch.TokenLimit
	cfg.ApiKeys[idx].CreditLimit = patch.CreditLimit
	cfg.ApiKeys[idx].CallLimit = patch.CallLimit
	cfg.ApiKeys[idx].AccountIDs = accountIDs
	return Save()
}

func validateApiKeyLimits(tokenLimit int64, creditLimit float64) error {
	if tokenLimit < 0 {
		return ErrTokenLimitNegative
	}
	if creditLimit < 0 {
		return ErrCreditLimitNegative
	}
	return nil
}

func DeleteApiKey(id string) error {
	return deleteApiKey(id, false)
}

// DeleteApiKeyGuarded is DeleteApiKey that returns ErrApiKeyLockout instead of
// deleting the last enabled key while keys are required.
func DeleteApiKeyGuarded(id string) error {
	return deleteApiKey(id, true)
}

func deleteApiKey(id string, guard bool) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	for i, entry := range cfg.ApiKeys {
		if entry.ID == id {
			if guard && removingKeyLocksOutLocked(entry) {
				return ErrApiKeyLockout
			}
			cfg.ApiKeys = append(cfg.ApiKeys[:i], cfg.ApiKeys[i+1:]...)
			delete(apiKeyPendingCalls, id)
			return Save()
		}
	}
	return nil
}

// removingKeyLocksOutLocked reports whether disabling or deleting entry would
// leave no enabled key while keys are required. Caller holds cfgLock.
func removingKeyLocksOutLocked(entry ApiKeyEntry) bool {
	return entry.Enabled && cfg.RequireApiKey && countEnabledApiKeysLocked() <= 1
}

// CountEnabledApiKeys is how many keys a client can authenticate with right now.
func CountEnabledApiKeys() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return 0
	}
	return countEnabledApiKeysLocked()
}

func countEnabledApiKeysLocked() int {
	n := 0
	for _, entry := range cfg.ApiKeys {
		if entry.Enabled {
			n++
		}
	}
	return n
}

func FindApiKeyByValue(key string) *ApiKeyEntry {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || key == "" {
		return nil
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].Key == key {
			cp := cfg.ApiKeys[i]
			return &cp
		}
	}
	return nil
}

func HasApiKeys() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg != nil && len(cfg.ApiKeys) > 0
}

func RecordApiKeyUsage(id string, tokens int64, credits float64) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID == id {
			if tokens > 0 {
				cfg.ApiKeys[i].TokensUsed += tokens
			}
			if credits > 0 {
				cfg.ApiKeys[i].CreditsUsed += credits
			}
			cfg.ApiKeys[i].RequestsCount++
			cfg.ApiKeys[i].SuccessfulCalls++
			cfg.ApiKeys[i].LastUsedAt = time.Now().Unix()
			return saveLocked()
		}
	}
	return ErrApiKeyNotFound
}

func ReserveApiKeyUsage(id string, tokens int64, credits float64) error {
	if tokens < 0 || credits < 0 {
		return errors.New("usage reservation must be zero or positive")
	}
	return reserveApiKeyUsageLocked(id, tokens, credits)
}

func ReserveApiKeyRequestUsage(id string, tokens int64) (float64, error) {
	if tokens < 0 {
		return 0, errors.New("usage reservation must be zero or positive")
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return 0, errors.New("config not initialized")
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID != id {
			continue
		}
		credits := 0.0
		if cfg.ApiKeys[i].CreditLimit > 0 && cfg.ApiKeys[i].CreditsUsed >= cfg.ApiKeys[i].CreditLimit {
			return 0, errors.New("credit limit exceeded")
		}
		if err := reserveCallSlotLocked(i); err != nil {
			return 0, err
		}
		if err := reserveApiKeyUsageAtIndexLocked(i, tokens, credits); err != nil {
			releaseCallSlotLocked(id)
			return 0, err
		}
		return credits, nil
	}
	return 0, ErrApiKeyNotFound
}

func reserveApiKeyUsageLocked(id string, tokens int64, credits float64) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID != id {
			continue
		}
		return reserveApiKeyUsageAtIndexLocked(i, tokens, credits)
	}
	return ErrApiKeyNotFound
}

func reserveApiKeyUsageAtIndexLocked(i int, tokens int64, credits float64) error {
	if !cfg.ApiKeys[i].Enabled {
		return errors.New("api key disabled")
	}
	if cfg.ApiKeys[i].TokenLimit > 0 && cfg.ApiKeys[i].TokensUsed+tokens > cfg.ApiKeys[i].TokenLimit {
		return errors.New("token limit exceeded")
	}
	if cfg.ApiKeys[i].CreditLimit > 0 && cfg.ApiKeys[i].CreditsUsed+credits > cfg.ApiKeys[i].CreditLimit {
		return errors.New("credit limit exceeded")
	}
	cfg.ApiKeys[i].TokensUsed += tokens
	cfg.ApiKeys[i].CreditsUsed += credits
	if err := saveLocked(); err != nil {
		cfg.ApiKeys[i].TokensUsed -= tokens
		cfg.ApiKeys[i].CreditsUsed -= credits
		return err
	}
	return nil
}

func ReleaseApiKeyUsageReservation(id string, tokens int64, credits float64) error {
	if tokens < 0 || credits < 0 {
		return errors.New("usage reservation must be zero or positive")
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	releaseCallSlotLocked(id)
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID != id {
			continue
		}
		cfg.ApiKeys[i].TokensUsed -= tokens
		if cfg.ApiKeys[i].TokensUsed < 0 {
			cfg.ApiKeys[i].TokensUsed = 0
		}
		cfg.ApiKeys[i].CreditsUsed -= credits
		if cfg.ApiKeys[i].CreditsUsed < 0 {
			cfg.ApiKeys[i].CreditsUsed = 0
		}
		return saveLocked()
	}
	return ErrApiKeyNotFound
}

func FinalizeApiKeyUsageReservation(id string, reservedTokens int64, reservedCredits float64, actualTokens int64, actualCredits float64) error {
	if reservedTokens < 0 || reservedCredits < 0 || actualTokens < 0 || actualCredits < 0 {
		return errors.New("api key usage must be zero or positive")
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	releaseCallSlotLocked(id)
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID != id {
			continue
		}
		cfg.ApiKeys[i].TokensUsed += actualTokens - reservedTokens
		if cfg.ApiKeys[i].TokensUsed < 0 {
			cfg.ApiKeys[i].TokensUsed = 0
		}
		cfg.ApiKeys[i].CreditsUsed += actualCredits - reservedCredits
		if cfg.ApiKeys[i].CreditsUsed < 0 {
			cfg.ApiKeys[i].CreditsUsed = 0
		}
		if cfg.ApiKeys[i].TokenLimit > 0 && cfg.ApiKeys[i].TokensUsed >= cfg.ApiKeys[i].TokenLimit {
			cfg.ApiKeys[i].Enabled = false
		}
		if cfg.ApiKeys[i].CreditLimit > 0 && cfg.ApiKeys[i].CreditsUsed >= cfg.ApiKeys[i].CreditLimit {
			cfg.ApiKeys[i].Enabled = false
		}
		cfg.ApiKeys[i].RequestsCount++
		//! The one place a call counts: it runs once per request that finished OK.
		cfg.ApiKeys[i].SuccessfulCalls++
		cfg.ApiKeys[i].LastUsedAt = time.Now().Unix()
		return saveLocked()
	}
	return ErrApiKeyNotFound
}

func ResetApiKeyUsage(id string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	for i := range cfg.ApiKeys {
		if cfg.ApiKeys[i].ID == id {
			cfg.ApiKeys[i].TokensUsed = 0
			cfg.ApiKeys[i].CreditsUsed = 0
			cfg.ApiKeys[i].RequestsCount = 0
			cfg.ApiKeys[i].SuccessfulCalls = 0
			return saveLocked()
		}
	}
	return ErrApiKeyNotFound
}

func GenerateApiKeyValue() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "sk-" + strings.ReplaceAll(GenerateMachineId(), "-", "")
	}
	return "sk-" + hex.EncodeToString(buf)
}

func MaskApiKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 10 {
		//! Too short to show any part of it.
		return "****"
	}
	return key[:6] + "****" + key[len(key)-4:]
}

func ApiKeyOverLimit(entry ApiKeyEntry) (overToken bool, overCredit bool) {
	if entry.TokenLimit > 0 && entry.TokensUsed >= entry.TokenLimit {
		overToken = true
	}
	if entry.CreditLimit > 0 && entry.CreditsUsed >= entry.CreditLimit {
		overCredit = true
	}
	return
}

package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
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
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return ApiKeyEntry{}, errors.New("config not initialized")
	}
	entry.Name = strings.TrimSpace(entry.Name)
	entry.Key = strings.TrimSpace(entry.Key)
	if entry.Key == "" {
		return ApiKeyEntry{}, errors.New("api key value must not be empty")
	}
	if err := validateApiKeyLimits(entry.TokenLimit, entry.CreditLimit); err != nil {
		return ApiKeyEntry{}, err
	}
	for _, existing := range cfg.ApiKeys {
		if existing.Key == entry.Key {
			return ApiKeyEntry{}, errors.New("api key already exists")
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
		return errors.New("api key not found")
	}
	if err := validateApiKeyLimits(patch.TokenLimit, patch.CreditLimit); err != nil {
		return err
	}
	name := strings.TrimSpace(patch.Name)
	newKey := ""
	if patch.Key != "" {
		newKey = strings.TrimSpace(patch.Key)
		if newKey == "" {
			return errors.New("api key value must not be empty")
		}
		for j := range cfg.ApiKeys {
			if j != idx && cfg.ApiKeys[j].Key == newKey {
				return errors.New("api key value collides with existing entry")
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
	return Save()
}

func validateApiKeyLimits(tokenLimit int64, creditLimit float64) error {
	if tokenLimit < 0 {
		return errors.New("token limit must be zero or positive")
	}
	if creditLimit < 0 {
		return errors.New("credit limit must be zero or positive")
	}
	return nil
}

func DeleteApiKey(id string) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if cfg == nil {
		return errors.New("config not initialized")
	}
	for i, entry := range cfg.ApiKeys {
		if entry.ID == id {
			cfg.ApiKeys = append(cfg.ApiKeys[:i], cfg.ApiKeys[i+1:]...)
			return Save()
		}
	}
	return nil
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
			cfg.ApiKeys[i].LastUsedAt = time.Now().Unix()
			return saveLocked()
		}
	}
	return errors.New("api key not found")
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
		if err := reserveApiKeyUsageAtIndexLocked(i, tokens, credits); err != nil {
			return 0, err
		}
		return credits, nil
	}
	return 0, errors.New("api key not found")
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
	return errors.New("api key not found")
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
	return errors.New("api key not found")
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
		cfg.ApiKeys[i].LastUsedAt = time.Now().Unix()
		return saveLocked()
	}
	return errors.New("api key not found")
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
			return saveLocked()
		}
	}
	return errors.New("api key not found")
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
		return key
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

package config

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const AuthMethodAPIKey = "api_key"

var (
	ErrEmptyKiroAPIKey     = errors.New("kiroApiKey is empty")
	ErrInvalidKiroAPIKey   = errors.New("kiroApiKey contains invalid characters")
	ErrInvalidKiroRegion   = errors.New("invalid Kiro API key region")
	ErrDuplicateKiroAPIKey = errors.New("this Kiro API key is already added")

	kiroAPIKeyRegionPattern = regexp.MustCompile(`^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$`)
)

func IsAPIKeyAccount(account *Account) bool {
	if account == nil {
		return false
	}
	if strings.TrimSpace(account.KiroApiKey) != "" {
		return true
	}
	method := strings.ToLower(strings.TrimSpace(account.AuthMethod))
	return method == AuthMethodAPIKey || method == "apikey"
}

func LooksLikeKiroAPIKey(value string) bool {
	//! Only a hint for plain-text imports; explicit kiroApiKey / authMethod still accept other formats.
	key, _, _ := strings.Cut(strings.TrimSpace(value), "|")
	return strings.HasPrefix(strings.TrimSpace(key), "ksk_")
}

func SplitKiroAPIKeyAndRegion(raw string) (key, region string, err error) {
	//! Accepts the "ksk_...|region" convenience form used by Kiro CLI exports.
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", ErrEmptyKiroAPIKey
	}
	parts := strings.Split(trimmed, "|")
	if len(parts) > 2 {
		return "", "", errors.New("kiroApiKey has more than one '|' separator")
	}
	key = strings.TrimSpace(parts[0])
	if key == "" {
		return "", "", ErrEmptyKiroAPIKey
	}
	for i := 0; i < len(key); i++ {
		//! The key goes into an Authorization header, so only visible ASCII is allowed.
		if key[i] < 0x21 || key[i] > 0x7e {
			return "", "", ErrInvalidKiroAPIKey
		}
	}
	if len(parts) == 2 {
		region = strings.ToLower(strings.TrimSpace(parts[1]))
		if !kiroAPIKeyRegionPattern.MatchString(region) {
			return "", "", ErrInvalidKiroRegion
		}
	}
	return key, region, nil
}

func KiroAPIKeyFingerprint(apiKey string) string {
	if apiKey == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(apiKey))
	return fmt.Sprintf("%x", sum[:])
}

func MachineIdFromAPIKey(apiKey string) string {
	//! Kiro CLI derives its machine id as sha256("KiroAPIKey/<key>"); matching it keeps the key's fingerprint stable.
	sum := sha256.Sum256([]byte("KiroAPIKey/" + apiKey))
	return fmt.Sprintf("%x", sum[:])
}

func NormalizeAPIKeyAccount(account *Account) error {
	//! AccessToken mirrors the key so every shared Bearer path works; ExpiresAt 0 keeps OAuth refresh away.
	if account == nil {
		return errors.New("account is nil")
	}
	raw := strings.TrimSpace(account.KiroApiKey)
	if raw == "" {
		raw = strings.TrimSpace(account.AccessToken)
	}
	key, keyRegion, err := SplitKiroAPIKeyAndRegion(raw)
	if err != nil {
		return err
	}
	account.KiroApiKey = key
	account.AccessToken = key
	account.AuthMethod = AuthMethodAPIKey
	account.RefreshToken = ""
	account.ClientID = ""
	account.ClientSecret = ""
	account.StartUrl = ""
	account.ProfileArn = ""
	account.ExpiresAt = 0

	region := strings.ToLower(strings.TrimSpace(account.Region))
	if region == "" {
		region = keyRegion
	}
	if region == "" {
		region = "us-east-1"
	}
	if !kiroAPIKeyRegionPattern.MatchString(region) {
		return ErrInvalidKiroRegion
	}
	account.Region = region

	if strings.TrimSpace(account.MachineId) == "" {
		account.MachineId = MachineIdFromAPIKey(key)
	}
	if strings.TrimSpace(account.Provider) == "" {
		account.Provider = "APIKey"
	}
	if strings.TrimSpace(account.Email) == "" {
		//! A stable label that never shows the secret itself.
		account.Email = "api-key-" + KiroAPIKeyFingerprint(key)[:12]
	}
	return nil
}

func hasKiroAPIKey(accounts []Account, apiKey string) bool {
	if apiKey == "" {
		return false
	}
	for i := range accounts {
		if strings.TrimSpace(accounts[i].KiroApiKey) == apiKey {
			return true
		}
	}
	return false
}

func AccountAPIKeyExists(apiKey string) bool {
	return hasKiroAPIKey(GetAccounts(), strings.TrimSpace(apiKey))
}

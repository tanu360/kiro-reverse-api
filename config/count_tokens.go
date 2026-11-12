package config

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// How the external count_tokens service receives its key.
const (
	CountTokensAuthXAPIKey = "x-api-key"
	CountTokensAuthBearer  = "bearer"
)

const (
	MaxCountTokensURLLen = 2048
	MaxCountTokensKeyLen = 4096
)

// CountTokensSettings is the optional external service that /v1/messages/count_tokens asks
// before falling back to the local estimate. An empty APIURL means local only.
type CountTokensSettings struct {
	APIURL   string
	APIKey   string
	AuthType string
}

// GetCountTokensSettings reads the saved service; an empty or unknown auth type reads as x-api-key.
func GetCountTokensSettings() CountTokensSettings {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return CountTokensSettings{AuthType: CountTokensAuthXAPIKey}
	}
	authType := cfg.CountTokensAuthType
	if !ValidCountTokensAuthType(authType) {
		authType = CountTokensAuthXAPIKey
	}
	return CountTokensSettings{
		APIURL:   cfg.CountTokensApiURL,
		APIKey:   cfg.CountTokensApiKey,
		AuthType: authType,
	}
}

// ValidCountTokensAuthType reports whether s names a supported auth header mode.
func ValidCountTokensAuthType(s string) bool {
	return s == CountTokensAuthXAPIKey || s == CountTokensAuthBearer
}

// ValidateCountTokensURL accepts an absolute http(s) URL with a host. Credentials in the URL are
// refused: the admin API echoes the URL back, so a secret belongs in the key field.
func ValidateCountTokensURL(raw string) error {
	if raw == "" {
		return errors.New("countTokensApiUrl is empty")
	}
	if len(raw) > MaxCountTokensURLLen {
		return fmt.Errorf("countTokensApiUrl is longer than %d characters", MaxCountTokensURLLen)
	}
	if strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return errors.New("countTokensApiUrl must not contain spaces or control characters")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("countTokensApiUrl is not a valid URL")
	}
	if scheme := strings.ToLower(u.Scheme); scheme != "http" && scheme != "https" {
		return errors.New("countTokensApiUrl must start with http:// or https://")
	}
	if u.Hostname() == "" {
		return errors.New("countTokensApiUrl must include a host")
	}
	if u.User != nil {
		return errors.New("countTokensApiUrl must not contain a user name or password; put the key in countTokensApiKey")
	}
	return nil
}

// ValidateCountTokensKey accepts a key that fits in one HTTP header value.
func ValidateCountTokensKey(key string) error {
	if utf8.RuneCountInString(key) > MaxCountTokensKeyLen {
		return fmt.Errorf("countTokensApiKey is longer than %d characters", MaxCountTokensKeyLen)
	}
	if strings.IndexFunc(key, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r > unicode.MaxASCII }) >= 0 {
		return errors.New("countTokensApiKey must be printable ASCII without spaces")
	}
	return nil
}

// UpdateCountTokensSettings saves the external service. An empty apiURL turns it off and drops
// the URL, key and auth type. A nil or empty apiKey keeps the saved key; clearKey drops it, and
// a new key given in the same call replaces it.
func UpdateCountTokensSettings(apiURL, authType string, apiKey *string, clearKey bool) error {
	apiURL = strings.TrimSpace(apiURL)
	if apiURL == "" {
		cfgLock.Lock()
		defer cfgLock.Unlock()
		cfg.CountTokensApiURL = ""
		cfg.CountTokensApiKey = ""
		cfg.CountTokensAuthType = ""
		return Save()
	}
	if err := ValidateCountTokensURL(apiURL); err != nil {
		return err
	}
	if authType == "" {
		authType = CountTokensAuthXAPIKey
	}
	if !ValidCountTokensAuthType(authType) {
		return fmt.Errorf("countTokensAuthType must be %q or %q", CountTokensAuthXAPIKey, CountTokensAuthBearer)
	}
	newKey := ""
	if apiKey != nil {
		newKey = strings.TrimSpace(*apiKey)
		if err := ValidateCountTokensKey(newKey); err != nil {
			return err
		}
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.CountTokensApiURL = apiURL
	cfg.CountTokensAuthType = authType
	if clearKey {
		cfg.CountTokensApiKey = ""
	}
	if newKey != "" {
		cfg.CountTokensApiKey = newKey
	}
	return Save()
}

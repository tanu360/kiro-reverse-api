package config

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Client API key controls beyond the usage limits: the accounts a key picks by
// tag, the models it may call, its own requests-per-minute limit, when it
// expires and the routing mode it picks accounts with.

const (
	// MaxApiKeyRPMLimit caps a key's requests-per-minute limit.
	MaxApiKeyRPMLimit = 10000
	// MaxApiKeyModels is how many models one key's allowlist may name.
	MaxApiKeyModels = 50
	// MaxApiKeyModelRunes bounds one model name on that list.
	MaxApiKeyModelRunes = 128
	// ApiKeyRoutingModeInherit is the admin API spelling of "follow the global
	// routing mode". It is stored as "".
	ApiKeyRoutingModeInherit = "inherit"
)

var (
	ErrApiKeyRPMLimitRange  = fmt.Errorf("rpm limit must be between 0 and %d", MaxApiKeyRPMLimit)
	ErrApiKeyExpiryNegative = errors.New("expiry must be zero (never) or a unix time")
	ErrApiKeyRoutingMode    = errors.New(`routingMode must be "inherit", "weighted", "priority" or "reset_first"`)
	ErrApiKeyTooManyModels  = fmt.Errorf("an API key may allow at most %d models", MaxApiKeyModels)
	ErrApiKeyModelTooLong   = fmt.Errorf("a model name may be at most %d characters", MaxApiKeyModelRunes)
	ErrApiKeyTooManyTags    = fmt.Errorf("an API key may select at most %d account tags", MaxAccountTags)
)

// apiKeyControls is the part of a key the admin API edits next to its limits.
type apiKeyControls struct {
	accountTags   []string
	allowedModels []string
	rpmLimit      int
	expiresAt     int64
	routingMode   string
}

// normalizeApiKeyControls checks and cleans the controls of an incoming key.
func normalizeApiKeyControls(entry ApiKeyEntry) (apiKeyControls, error) {
	var out apiKeyControls
	if entry.RPMLimit < 0 || entry.RPMLimit > MaxApiKeyRPMLimit {
		return out, ErrApiKeyRPMLimitRange
	}
	if entry.ExpiresAt < 0 {
		return out, ErrApiKeyExpiryNegative
	}
	mode, err := NormalizeApiKeyRoutingMode(entry.RoutingMode)
	if err != nil {
		return out, err
	}
	tags, err := normalizeApiKeyTags(entry.AccountTags)
	if err != nil {
		return out, err
	}
	models, err := normalizeApiKeyModels(entry.AllowedModels)
	if err != nil {
		return out, err
	}
	out.accountTags = tags
	out.allowedModels = models
	out.rpmLimit = entry.RPMLimit
	out.expiresAt = entry.ExpiresAt
	out.routingMode = mode
	return out, nil
}

func (c apiKeyControls) apply(entry *ApiKeyEntry) {
	entry.AccountTags = c.accountTags
	entry.AllowedModels = c.allowedModels
	entry.RPMLimit = c.rpmLimit
	entry.ExpiresAt = c.expiresAt
	entry.RoutingMode = c.routingMode
}

// NormalizeApiKeyRoutingMode reads a key's routing mode as the admin API
// takes it: "" or "inherit" follow the global mode (stored as ""), and the
// routing modes themselves pick with that mode.
func NormalizeApiKeyRoutingMode(mode string) (string, error) {
	mode = strings.TrimSpace(mode)
	if mode == "" || mode == ApiKeyRoutingModeInherit {
		return "", nil
	}
	if !ValidRoutingMode(mode) {
		return "", ErrApiKeyRoutingMode
	}
	return mode, nil
}

// normalizeApiKeyTags normalizes each tag the way an account's tags are
// (NormalizeAccountTag), so a key tag matches the account tag it was typed
// as, drops blanks and case-insensitive duplicates (the first spelling wins)
// and refuses more than MaxAccountTags. An empty result is nil: no account is
// picked by tag.
func normalizeApiKeyTags(tags []string) ([]string, error) {
	var out []string
	for _, raw := range tags {
		tag := NormalizeAccountTag(raw)
		if tag == "" || containsTagFold(out, tag) {
			continue
		}
		if len(out) == MaxAccountTags {
			return nil, ErrApiKeyTooManyTags
		}
		out = append(out, tag)
	}
	return out, nil
}

// normalizeApiKeyModels trims the names and drops blanks and case-insensitive
// duplicates. An empty result is nil: every model.
func normalizeApiKeyModels(models []string) ([]string, error) {
	var out []string
	for _, raw := range models {
		model := strings.TrimSpace(raw)
		if model == "" {
			continue
		}
		if utf8.RuneCountInString(model) > MaxApiKeyModelRunes {
			return nil, ErrApiKeyModelTooLong
		}
		if containsTagFold(out, model) {
			continue
		}
		if len(out) == MaxApiKeyModels {
			return nil, ErrApiKeyTooManyModels
		}
		out = append(out, model)
	}
	return out, nil
}

// ApiKeyScoped reports whether the key is limited to some accounts, by id or
// by tag. An unscoped key may use every account.
func ApiKeyScoped(entry ApiKeyEntry) bool {
	return len(entry.AccountIDs) > 0 || len(entry.AccountTags) > 0
}

// ApiKeyAllowedAccounts is the set of accounts the key may use: its account
// ids together with every account in accounts that carries one of its tags
// (case-insensitive). It is nil for an unscoped key, meaning every account,
// and an empty, non-nil set for a scoped key that matches no account, so that
// key gets no account at all rather than every one.
func ApiKeyAllowedAccounts(entry ApiKeyEntry, accounts []Account) map[string]bool {
	if !ApiKeyScoped(entry) {
		return nil
	}
	allowed := make(map[string]bool, len(entry.AccountIDs))
	for _, id := range entry.AccountIDs {
		allowed[id] = true
	}
	if len(entry.AccountTags) == 0 {
		return allowed
	}
	for i := range accounts {
		for _, tag := range accounts[i].Tags {
			if containsTagFold(entry.AccountTags, tag) {
				allowed[accounts[i].ID] = true
				break
			}
		}
	}
	return allowed
}

// ApiKeyAllowsModel reports whether the key may call model, the model a
// request resolves to after the thinking suffix and the model mappings. A key
// without an allowlist may call every model. The match ignores case.
func ApiKeyAllowsModel(entry ApiKeyEntry, model string) bool {
	if len(entry.AllowedModels) == 0 {
		return true
	}
	model = strings.TrimSpace(model)
	for _, allowed := range entry.AllowedModels {
		if strings.EqualFold(allowed, model) {
			return true
		}
	}
	return false
}

// ApiKeyExpired reports whether the key's expiry time has come.
func ApiKeyExpired(entry ApiKeyEntry, now time.Time) bool {
	return entry.ExpiresAt > 0 && now.Unix() >= entry.ExpiresAt
}

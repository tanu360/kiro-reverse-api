package config

import (
	"crypto/rand"
	"encoding/hex"
)

// MetricsSettings is the Prometheus endpoint's switch and its bearer token.
type MetricsSettings struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token,omitempty"`
}

func newMetricsToken() (string, error) {
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "kpm_" + hex.EncodeToString(buf[:]), nil
}

// GetMetricsSettings is the /metrics switch and token; off by default.
func GetMetricsSettings() MetricsSettings {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return MetricsSettings{}
	}
	return MetricsSettings{Enabled: cfg.MetricsEnabled, Token: cfg.MetricsToken}
}

// UpdateMetricsSettings turns /metrics on or off (nil keeps it) and makes a new
// token when regenerate is set or the endpoint turns on without one.
func UpdateMetricsSettings(enabled *bool, regenerate bool) (MetricsSettings, error) {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if enabled != nil {
		cfg.MetricsEnabled = *enabled
	}
	if regenerate || (cfg.MetricsEnabled && cfg.MetricsToken == "") {
		token, err := newMetricsToken()
		if err != nil {
			return MetricsSettings{}, err
		}
		cfg.MetricsToken = token
	}
	if err := Save(); err != nil {
		return MetricsSettings{}, err
	}
	return MetricsSettings{Enabled: cfg.MetricsEnabled, Token: cfg.MetricsToken}, nil
}

package config

import (
	"errors"
)

// PoolProxy is one outbound proxy of the pool. URL holds scheme://host:port only;
// the sign-in lives in Username and Password, so a view can drop the password
// without parsing the URL.
type PoolProxy struct {
	ID        string `json:"id"`
	Label     string `json:"label,omitempty"`
	URL       string `json:"url"`
	Username  string `json:"username,omitempty"`
	Password  string `json:"password,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
	// Disabled is the admin's off switch: the pool never routes through the proxy
	// and never checks it, and no health check switches it back on.
	Disabled bool `json:"disabled,omitempty"`
}

const (
	ProxyPoolModeOff = "off"
	ProxyPoolModeOn  = "on"

	// DefaultProxyPoolCheckIntervalMin is the health check period when none was saved.
	DefaultProxyPoolCheckIntervalMin = 10
	// MaxProxyPoolCheckIntervalMin is one day.
	MaxProxyPoolCheckIntervalMin = 1440
)

var (
	ErrProxyPoolMode          = errors.New("proxyPoolMode must be on or off")
	ErrProxyPoolCheckInterval = errors.New("checkIntervalMin must be between 0 and 1440")
)

// proxyPoolStateKey holds health and account assignments. They change on every
// check, so they stay out of the config row: config.Save snapshots a backup first.
const proxyPoolStateKey = "proxy_pool_state"

func GetProxyPool() []PoolProxy {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || len(cfg.ProxyPool) == 0 {
		return nil
	}
	return append([]PoolProxy(nil), cfg.ProxyPool...)
}

func SetProxyPool(proxies []PoolProxy) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.ProxyPool = append([]PoolProxy(nil), proxies...)
	return Save()
}

// GetProxyPoolMode is "on" or "off"; off by default.
func GetProxyPoolMode() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.ProxyPoolMode != ProxyPoolModeOn {
		return ProxyPoolModeOff
	}
	return ProxyPoolModeOn
}

// GetProxyDirectFallback reports whether an account goes on down the route
// (global proxy, then direct) when no pool proxy is healthy. Off by default:
// an operator who set up a pool usually does not want the server's own IP used.
func GetProxyDirectFallback() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.ProxyDirectFallback
}

// GetProxyPoolCheckIntervalMin is the period of the background health check in
// minutes; 0 turns it off.
func GetProxyPoolCheckIntervalMin() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.ProxyPoolCheckIntervalMin == nil {
		return DefaultProxyPoolCheckIntervalMin
	}
	return *cfg.ProxyPoolCheckIntervalMin
}

// UpdateProxyPoolSettings saves the pool settings that are not nil, in one write.
func UpdateProxyPoolSettings(mode *string, directFallback *bool, checkIntervalMin *int) error {
	if mode != nil && *mode != ProxyPoolModeOn && *mode != ProxyPoolModeOff {
		return ErrProxyPoolMode
	}
	if checkIntervalMin != nil && (*checkIntervalMin < 0 || *checkIntervalMin > MaxProxyPoolCheckIntervalMin) {
		return ErrProxyPoolCheckInterval
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	if mode != nil {
		cfg.ProxyPoolMode = *mode
	}
	if directFallback != nil {
		cfg.ProxyDirectFallback = *directFallback
	}
	if checkIntervalMin != nil {
		minutes := *checkIntervalMin
		cfg.ProxyPoolCheckIntervalMin = &minutes
	}
	return Save()
}

// LoadProxyPoolState returns the saved pool state JSON, or "" when none was saved.
func LoadProxyPoolState() (string, error) {
	raw, ok, err := getSetting(proxyPoolStateKey)
	if err != nil || !ok {
		return "", err
	}
	return raw, nil
}

func SaveProxyPoolState(raw string) error {
	return setSetting(proxyPoolStateKey, raw)
}

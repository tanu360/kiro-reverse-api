package config

import (
	"fmt"
	"regexp"
)

// DefaultTunnelHostname is the device name the public link starts with:
// https://kiro-proxy.<tailnet>.ts.net.
const DefaultTunnelHostname = "kiro-proxy"

// TunnelSettings is the public link's switch and its device name in the tailnet.
type TunnelSettings struct {
	Enabled  bool   `json:"enabled,omitempty"`
	Hostname string `json:"hostname,omitempty"`
}

// tunnelHostnamePattern is one DNS label: the device name becomes the first
// part of the link's host name.
var tunnelHostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidTunnelHostname reports whether name works as the link's device name.
func ValidTunnelHostname(name string) bool {
	return tunnelHostnamePattern.MatchString(name)
}

// GetTunnelSettings returns the public link's settings; an unset or invalid
// device name reads as the default.
func GetTunnelSettings() TunnelSettings {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return TunnelSettings{Hostname: DefaultTunnelHostname}
	}
	settings := cfg.Tunnel
	if !ValidTunnelHostname(settings.Hostname) {
		settings.Hostname = DefaultTunnelHostname
	}
	return settings
}

// UpdateTunnelSettings saves the switch and the device name.
func UpdateTunnelSettings(settings TunnelSettings) error {
	if !ValidTunnelHostname(settings.Hostname) {
		return fmt.Errorf("the device name %q must be 1 to 63 lowercase letters, digits or hyphens, and start and end with a letter or digit", settings.Hostname)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.Tunnel = settings
	return Save()
}

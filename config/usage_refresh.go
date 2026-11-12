package config

import (
	"fmt"
	"time"
)

// The background usage refresh interval, in minutes. 0 turns the sweep off;
// on, it runs at most every 5 minutes and at least once a day.
const (
	DefaultUsageRefreshIntervalMinutes = 30
	MinUsageRefreshIntervalMinutes     = 5
	MaxUsageRefreshIntervalMinutes     = 1440
)

// ValidUsageRefreshIntervalMinutes reports whether n is a value the setting accepts.
func ValidUsageRefreshIntervalMinutes(n int) bool {
	return n == 0 || (n >= MinUsageRefreshIntervalMinutes && n <= MaxUsageRefreshIntervalMinutes)
}

// GetUsageRefreshIntervalMinutes returns how often the background sweep refreshes
// every account's usage and tokens, in minutes; 0 means off. A config saved before
// the setting existed reads as the default, and a hand-edited value outside the
// range reads as the nearest bound.
func GetUsageRefreshIntervalMinutes() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.UsageRefreshIntervalMinutes == nil {
		return DefaultUsageRefreshIntervalMinutes
	}
	n := *cfg.UsageRefreshIntervalMinutes
	switch {
	case n < 0:
		return DefaultUsageRefreshIntervalMinutes
	case n == 0:
		return 0
	case n < MinUsageRefreshIntervalMinutes:
		return MinUsageRefreshIntervalMinutes
	case n > MaxUsageRefreshIntervalMinutes:
		return MaxUsageRefreshIntervalMinutes
	}
	return n
}

// GetUsageRefreshInterval is GetUsageRefreshIntervalMinutes as a duration; 0 means off.
func GetUsageRefreshInterval() time.Duration {
	return time.Duration(GetUsageRefreshIntervalMinutes()) * time.Minute
}

func UpdateUsageRefreshIntervalMinutes(n int) error {
	if !ValidUsageRefreshIntervalMinutes(n) {
		return fmt.Errorf("usageRefreshIntervalMinutes must be 0 (off) or between %d and %d",
			MinUsageRefreshIntervalMinutes, MaxUsageRefreshIntervalMinutes)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.UsageRefreshIntervalMinutes = &n
	return Save()
}

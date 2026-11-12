package config

import "fmt"

const (
	// DefaultLogRetentionDays applies while logRetentionDays was never set.
	DefaultLogRetentionDays = 90
	// MaxLogRetentionDays is about ten years.
	MaxLogRetentionDays = 3650
)

// GetLogRetentionDays returns how many days of the request and error logs are
// kept; 0 keeps them forever. Unset means the default.
func GetLogRetentionDays() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.LogRetentionDays == nil {
		return DefaultLogRetentionDays
	}
	//! A stored value out of range (an edited config) reads as the nearest bound,
	//! so a negative one keeps everything instead of pruning it all.
	return min(max(*cfg.LogRetentionDays, 0), MaxLogRetentionDays)
}

func UpdateLogRetentionDays(days int) error {
	if days < 0 || days > MaxLogRetentionDays {
		return fmt.Errorf("logRetentionDays must be between 0 and %d", MaxLogRetentionDays)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.LogRetentionDays = &days
	return Save()
}

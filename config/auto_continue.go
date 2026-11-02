package config

import "fmt"

const (
	DefaultAutoContinueMax = 3
	MaxAutoContinueMax     = 10
)

// GetAutoContinue reports whether an answer cut off at Kiro's output cap is resumed
// with follow-up requests. Off by default: every continuation is another billed request.
func GetAutoContinue() bool {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil {
		return false
	}
	return cfg.AutoContinue
}

func UpdateAutoContinue(enabled bool) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.AutoContinue = enabled
	return Save()
}

// GetAutoContinueMax returns how many follow-up requests one answer may use.
func GetAutoContinueMax() int {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.AutoContinueMax <= 0 {
		return DefaultAutoContinueMax
	}
	return min(cfg.AutoContinueMax, MaxAutoContinueMax)
}

func UpdateAutoContinueMax(n int) error {
	if n < 1 || n > MaxAutoContinueMax {
		return fmt.Errorf("autoContinueMax must be between 1 and %d", MaxAutoContinueMax)
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.AutoContinueMax = n
	return Save()
}

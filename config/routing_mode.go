package config

import "errors"

// Routing modes: how the pool picks the account for a new request.
//   - weighted: round-robin over the enabled accounts, an account with weight N
//     taking N slots of the rotation. The default.
//   - priority: the first account that can serve, in ascending Account.Priority
//     order (ties keep the account-list order). Weight is ignored.
const (
	RoutingModeWeighted = "weighted"
	RoutingModePriority = "priority"

	// MaxAccountPriority bounds Account.Priority (0..999, lower is tried first).
	MaxAccountPriority = 999
)

var ErrInvalidRoutingMode = errors.New(`routingMode must be "weighted" or "priority"`)

// GetRoutingMode returns the routing mode, weighted when it is unset or not a
// known mode (a hand-edited config), so a typo never strands the pool.
func GetRoutingMode() string {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	if cfg == nil || cfg.RoutingMode != RoutingModePriority {
		return RoutingModeWeighted
	}
	return RoutingModePriority
}

// UpdateRoutingMode stores mode, which must be exactly "weighted" or "priority".
// The pool reads it on every pick, so the change applies without a reload.
func UpdateRoutingMode(mode string) error {
	if !ValidRoutingMode(mode) {
		return ErrInvalidRoutingMode
	}
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.RoutingMode = mode
	return Save()
}

// ValidRoutingMode reports whether mode is one of the two routing modes.
func ValidRoutingMode(mode string) bool {
	return mode == RoutingModeWeighted || mode == RoutingModePriority
}

// ValidAccountPriority reports whether n is an account priority the admin API accepts.
func ValidAccountPriority(n int) bool {
	return n >= 0 && n <= MaxAccountPriority
}

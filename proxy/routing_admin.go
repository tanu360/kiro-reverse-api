package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"

	"kiro-proxy/config"
)

var errPriorityRange = fmt.Errorf("priority must be an integer between 0 and %d", config.MaxAccountPriority)

// parseAccountPriority reads "priority" from a PUT /admin/api/accounts/{id}
// body. present is false when the key is absent. When it is present it must be
// a JSON number holding an integer in 0..MaxAccountPriority: a string, null, a
// fraction or an out-of-range value is an error, not clamped, so a script sees
// what it got wrong.
func parseAccountPriority(updates map[string]interface{}) (value int, present bool, err error) {
	raw, ok := updates["priority"]
	if !ok {
		return 0, false, nil
	}
	n, isNumber := raw.(float64)
	if !isNumber || n != math.Trunc(n) || n < 0 || n > config.MaxAccountPriority {
		return 0, true, errPriorityRange
	}
	return int(n), true, nil
}

// writePriorityRange answers 400 priority_range.
func writePriorityRange(w http.ResponseWriter) {
	writeAdminError(w, http.StatusBadRequest, codePriorityRange, errPriorityRange.Error())
}

// rejectInvalidRoutingMode answers 400 routing_mode_invalid and returns true
// when a settings patch carries a routingMode that is not a known mode. It runs
// before the patch writes anything.
func rejectInvalidRoutingMode(w http.ResponseWriter, mode *string) bool {
	if mode == nil || config.ValidRoutingMode(*mode) {
		return false
	}
	writeAdminError(w, http.StatusBadRequest, codeRoutingModeInvalid, config.ErrInvalidRoutingMode.Error())
	return true
}

// applyRoutingMode stores a validated routingMode from a settings patch and
// reports whether the handler may go on. The pool reads the mode on every
// pick, so it needs no reload.
func applyRoutingMode(w http.ResponseWriter, mode *string) bool {
	if mode == nil {
		return true
	}
	if err := config.UpdateRoutingMode(*mode); err != nil {
		if errors.Is(err, config.ErrInvalidRoutingMode) {
			writeAdminError(w, http.StatusBadRequest, codeRoutingModeInvalid, err.Error())
			return false
		}
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return false
	}
	return true
}

// routingSettingsPatch is the routing part of a POST /admin/api/settings body,
// embedded in apiUpdateSettings' request so its fields decode from the top level.
type routingSettingsPatch struct {
	RoutingMode *string `json:"routingMode,omitempty"`
}

package proxy

import (
	"encoding/json"
	"errors"
	"net/http"

	"kiro-proxy/config"
)

// Codes of the self-heal settings errors. The admin UI checks both ranges
// before it saves, so it has no translation of its own for them.
const (
	codeSelfHealIntervalRange = "self_heal_interval_range"
	codeSelfHealRoundsRange   = "self_heal_rounds_range"
)

type accountHealthResponse struct {
	Enabled        bool                 `json:"enabled"`
	MinIntervalSec int                  `json:"minIntervalSec"`
	MaxRounds      int                  `json:"maxRounds"`
	State          config.SelfHealState `json:"state"`
}

// apiGetAccountHealth answers GET /admin/api/account-health: the self-heal
// settings and the healer's state.
func (h *Handler) apiGetAccountHealth(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(accountHealthResponse{
		Enabled:        config.GetSelfHeal(),
		MinIntervalSec: config.GetSelfHealIntervalSec(),
		MaxRounds:      config.GetSelfHealMaxRounds(),
		State:          healer.snapshot(),
	})
}

// apiUpdateAccountHealth answers POST /admin/api/account-health. The body is a
// patch: an omitted field keeps its value. Changes apply to the next heal.
func (h *Handler) apiUpdateAccountHealth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled        *bool `json:"enabled"`
		MinIntervalSec *int  `json:"minIntervalSec"`
		MaxRounds      *int  `json:"maxRounds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	err := config.UpdateSelfHealSettings(req.Enabled, req.MinIntervalSec, req.MaxRounds)
	switch {
	case errors.Is(err, config.ErrSelfHealIntervalRange):
		writeAdminError(w, http.StatusBadRequest, codeSelfHealIntervalRange, err.Error())
		return
	case errors.Is(err, config.ErrSelfHealRoundsRange):
		writeAdminError(w, http.StatusBadRequest, codeSelfHealRoundsRange, err.Error())
		return
	case err != nil:
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	healer.settingsChanged()
	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// apiResumeAccountHealth answers POST /admin/api/account-health/resume: it
// lifts a halt and restarts the round count.
func (h *Handler) apiResumeAccountHealth(w http.ResponseWriter, _ *http.Request) {
	healer.resume()
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

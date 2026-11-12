package proxy

import (
	"encoding/json"
	"net/http"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// GET /admin/api/upstream: the API domain, the two region overrides ("" = none) and
// the regions apiRegion may take.
func (h *Handler) apiGetUpstreamConfig(w http.ResponseWriter, _ *http.Request) {
	u := config.GetUpstreamConfig()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"apiDomain":  u.APIDomain,
		"authRegion": u.AuthRegion,
		"apiRegion":  u.APIRegion,
		"apiRegions": config.KiroServiceRegions(),
	})
}

// POST /admin/api/upstream: patch semantics. An omitted field keeps its value; "" clears an
// override (or resets apiDomain to amazonaws). Applies to the next upstream call, no restart.
func (h *Handler) apiUpdateUpstreamConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIDomain  *string `json:"apiDomain"`
		AuthRegion *string `json:"authRegion"`
		APIRegion  *string `json:"apiRegion"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}

	next := config.GetUpstreamConfig()
	if req.APIDomain != nil {
		domain, err := config.NormalizeAPIDomain(*req.APIDomain)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, codeInvalidAPIDomain, "Invalid apiDomain, must be: amazonaws or kiro")
			return
		}
		next.APIDomain = domain
	}
	if req.APIRegion != nil {
		region, err := config.NormalizeAPIRegionOverride(*req.APIRegion)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, codeInvalidRegion, "apiRegion must be us-east-1 or eu-central-1")
			return
		}
		next.APIRegion = region
	}
	if req.AuthRegion != nil {
		region, err := config.NormalizeAuthRegionOverride(*req.AuthRegion)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, codeInvalidRegion, "Invalid authRegion")
			return
		}
		next.AuthRegion = region
	}

	//! Every field was validated above, so an error here is a storage failure.
	if err := config.UpdateUpstreamConfig(next); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	logger.Infof("[Upstream] apiDomain=%s apiRegion=%q authRegion=%q", next.APIDomain, next.APIRegion, next.AuthRegion)
	publishEvent(eventSettingsChanged, "")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

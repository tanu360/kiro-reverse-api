package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const accountProfileDiscoveryTimeout = 30 * time.Second

// apiGetAccountProfiles lists the Kiro profiles an existing OAuth account can use.
func (h *Handler) apiGetAccountProfiles(w http.ResponseWriter, r *http.Request, id string) {
	account, ok := h.profileSwitchAccount(w, id)
	if !ok {
		return
	}
	profiles, err := h.discoverAccountProfiles(r.Context(), account)
	if err != nil {
		writeAdminErr(w, http.StatusBadGateway, err, "")
		return
	}
	current := strings.TrimSpace(account.ProfileArn)
	items := make([]map[string]interface{}, 0, len(profiles))
	for _, profile := range profiles {
		items = append(items, map[string]interface{}{
			"arn":     profile.ARN,
			"name":    profile.Name,
			"region":  profile.Region,
			"current": profile.ARN == current,
		})
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":      true,
		"profiles":     items,
		"currentArn":   current,
		"activeRegion": kiroRegionForProfile(account, ""),
		"pinned":       account.ProfileArnPinned,
	})
}

// apiSetAccountProfile pins {"profileArn": "..."}; an empty profileArn unpins
// and lets request-time resolution pick the profile again.
func (h *Handler) apiSetAccountProfile(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		ProfileArn string `json:"profileArn"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	account, ok := h.profileSwitchAccount(w, id)
	if !ok {
		return
	}

	requested := strings.TrimSpace(req.ProfileArn)
	if requested == "" {
		if err := config.PinAccountProfileArn(id, ""); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		h.afterAccountProfileChange(id)
		logger.Infof("[ProfileArn] %s returned to automatic profile selection", accountEmailForLog(account))
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "pinned": false})
		return
	}

	profileArn, region, valid := parseKiroProfileArn(requested)
	if !valid {
		writeAdminError(w, http.StatusBadRequest, codeProfileArnInvalid, "profileArn is invalid")
		return
	}
	//! Only a profile Kiro lists for this credential may be pinned; any other ARN would fail every request upstream.
	profiles, err := h.discoverAccountProfiles(r.Context(), account)
	if err != nil {
		writeAdminErr(w, http.StatusBadGateway, &profileVerifyError{err: err}, "")
		return
	}
	offered := false
	for _, profile := range profiles {
		if profile.ARN == profileArn {
			offered = true
			break
		}
	}
	if !offered {
		writeAdminError(w, http.StatusBadRequest, codeProfileNotAvailable, "Selected Kiro profile is not available for this account")
		return
	}
	if err := config.PinAccountProfileArn(id, profileArn); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.afterAccountProfileChange(id)
	logger.Infof("[ProfileArn] %s pinned to %s", accountEmailForLog(account), region)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"pinned":     true,
		"profileArn": profileArn,
		"region":     region,
	})
}

// profileSwitchAccount writes the error response itself when the account cannot switch profiles.
func (h *Handler) profileSwitchAccount(w http.ResponseWriter, id string) (*config.Account, bool) {
	account := findAccountByID(id)
	if account == nil {
		writeAdminError(w, http.StatusNotFound, codeAccountNotFound, "Account not found")
		return nil, false
	}
	if config.IsAPIKeyAccount(account) {
		writeAdminError(w, http.StatusBadRequest, codeAPIKeyAccountNoProfile, "API key accounts have no Kiro profile; their region is set at import")
		return nil, false
	}
	return account, true
}

func (h *Handler) discoverAccountProfiles(ctx context.Context, account *config.Account) ([]KiroProfile, error) {
	ctx, cancel := context.WithTimeout(ctx, accountProfileDiscoveryTimeout)
	defer cancel()
	if err := h.ensureValidTokenContext(ctx, account); err != nil {
		return nil, &tokenRefreshError{prefix: "Token refresh failed", err: err}
	}
	return DiscoverKiroProfiles(ctx, account)
}

func (h *Handler) afterAccountProfileChange(id string) {
	h.pool.Reload()
	//! The model list came from the old region's data plane; an empty list routes every model until the next sweep.
	h.pool.SetModelList(id, nil)
}

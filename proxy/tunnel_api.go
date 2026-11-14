package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/tunnel"
)

// The public link (Settings > Server): GET and POST /admin/api/tunnel, and POST
// /admin/api/tunnel/logout. tunnel.Manager runs the Tailscale helper; this file saves the
// switch and the device name, and reports both with the helper's state.
//
// Requests that come in through the link are from the internet, so two rules change for them:
// client API calls always need an API key (auth.go), and the first-run password is never shown
// (handler.go).

const (
	codeTunnelHostname = "tunnel_hostname"
	codeTunnelLogout   = "tunnel_logout"
)

// SetTunnel attaches the public link's manager and starts it as the settings say.
func (h *Handler) SetTunnel(m *tunnel.Manager) {
	h.tunnel = m
	h.applyTunnelSettings()
}

// applyTunnelSettings starts, restarts or stops the link to match the saved settings, as after
// a backup restore.
func (h *Handler) applyTunnelSettings() {
	if h.tunnel == nil {
		return
	}
	settings := config.GetTunnelSettings()
	h.tunnel.Apply(settings.Enabled, settings.Hostname)
}

// TunnelChanged publishes a settings event for each new state of the link, so the card follows
// without polling. Download progress publishes only every 20 percent.
func TunnelChanged(st tunnel.Status) {
	if st.State == tunnel.StateDownloading && st.Progress != nil && *st.Progress%20 != 0 {
		return
	}
	publishEvent(eventSettingsChanged, "tunnel")
}

type tunnelResponse struct {
	tunnel.Status
	Enabled         bool   `json:"enabled"`
	Hostname        string `json:"hostname"`
	DefaultHostname string `json:"defaultHostname"`
	// TwoFactor and APIKeys drive the card's warnings: a public sign-in page wants two-factor
	// sign-in, and public API calls need a key.
	TwoFactor bool `json:"twoFactor"`
	APIKeys   bool `json:"apiKeys"`
}

func (h *Handler) tunnelResponse() tunnelResponse {
	settings := config.GetTunnelSettings()
	status := tunnel.Status{State: tunnel.StateOff}
	if h.tunnel != nil {
		status = h.tunnel.Status()
	}
	return tunnelResponse{
		Status:          status,
		Enabled:         settings.Enabled,
		Hostname:        settings.Hostname,
		DefaultHostname: config.DefaultTunnelHostname,
		TwoFactor:       config.AdminTOTPEnabled(),
		APIKeys:         config.HasEnabledApiKey(),
	}
}

func (h *Handler) handleTunnelAPI(w http.ResponseWriter, r *http.Request, path string) {
	switch {
	case path == "" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(h.tunnelResponse())
	case path == "" && r.Method == http.MethodPost:
		h.apiUpdateTunnel(w, r)
	case path == "/logout" && r.Method == http.MethodPost:
		h.apiTunnelLogout(w, r)
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

func (h *Handler) apiUpdateTunnel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled  *bool   `json:"enabled"`
		Hostname *string `json:"hostname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	settings := config.GetTunnelSettings()
	if req.Enabled != nil {
		settings.Enabled = *req.Enabled
	}
	if req.Hostname != nil {
		if !config.ValidTunnelHostname(*req.Hostname) {
			writeAdminError(w, http.StatusBadRequest, codeTunnelHostname,
				"The device name must be 1 to 63 lowercase letters, digits or hyphens, and start and end with a letter or digit")
			return
		}
		settings.Hostname = *req.Hostname
	}
	if err := config.UpdateTunnelSettings(settings); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if settings.Enabled {
		logger.Infof("[Tunnel] Public link switched on (device %s)", settings.Hostname)
	} else {
		logger.Infof("[Tunnel] Public link switched off")
	}
	h.applyTunnelSettings()
	publishEvent(eventSettingsChanged, "tunnel")
	json.NewEncoder(w).Encode(h.tunnelResponse())
}

func (h *Handler) apiTunnelLogout(w http.ResponseWriter, r *http.Request) {
	settings := config.GetTunnelSettings()
	settings.Enabled = false
	if err := config.UpdateTunnelSettings(settings); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if h.tunnel != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		if err := h.tunnel.Logout(ctx); err != nil {
			logger.Warnf("[Tunnel] Sign-out: %v", err)
			publishEvent(eventSettingsChanged, "tunnel")
			writeAdminError(w, http.StatusBadGateway, codeTunnelLogout, err.Error())
			return
		}
	}
	logger.Infof("[Tunnel] Signed out of Tailscale")
	publishEvent(eventSettingsChanged, "tunnel")
	json.NewEncoder(w).Encode(h.tunnelResponse())
}

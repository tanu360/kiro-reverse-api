package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
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
// (handler.go). Their answers also go back through the helper, so a change that stops it (the
// switch off, a sign-out) answers first and stops it after; and the device name cannot change
// from there, since a new name moves the link the page is open on.

const (
	codeTunnelHostname     = "tunnel_hostname"
	codeTunnelLogout       = "tunnel_logout"
	codeTunnelRenameRemote = "tunnel_rename_remote"
)

// tunnelAnswerGrace is how long a change made through the link waits before it stops the helper,
// so the answer reaches the visitor first: the helper drops its connections when it stops.
var tunnelAnswerGrace = time.Second

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

// tunnelProgressGap spaces the download's progress events: the helper reports every percent.
const tunnelProgressGap = 250 * time.Millisecond

// lastTunnelProgress is when the last progress event went out, in Unix nanoseconds.
var lastTunnelProgress atomic.Int64

// TunnelChanged publishes a settings event for each new state of the link, so the card follows
// without polling. Download progress publishes at most every tunnelProgressGap, and always at 100
// percent.
func TunnelChanged(st tunnel.Status) {
	if st.State == tunnel.StateDownloading && st.Progress != nil && *st.Progress < 100 {
		now := time.Now().UnixNano()
		last := lastTunnelProgress.Load()
		if now-last < int64(tunnelProgressGap) || !lastTunnelProgress.CompareAndSwap(last, now) {
			return
		}
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
	// ViaLink says this request came through the link: the card locks the device name and
	// warns that turning the link off or signing out disconnects the page.
	ViaLink bool `json:"viaLink"`
}

func (h *Handler) tunnelResponse(r *http.Request) tunnelResponse {
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
		ViaLink:         tunnel.FromTunnel(r),
	}
}

// answerThenStop sends resp, the link as it will be, to a request that came through the link,
// then makes the change to the helper once the answer is out.
func answerThenStop(w http.ResponseWriter, resp tunnelResponse, stop func()) {
	json.NewEncoder(w).Encode(resp)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(tunnelAnswerGrace)
		stop()
	}()
}

func (h *Handler) handleTunnelAPI(w http.ResponseWriter, r *http.Request, path string) {
	switch {
	case path == "" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(h.tunnelResponse(r))
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
		if *req.Hostname != settings.Hostname && tunnel.FromTunnel(r) {
			writeAdminError(w, http.StatusForbidden, codeTunnelRenameRemote,
				"Change the device name from the dashboard's local address: a new name moves the link this page is open on")
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
	if tunnel.FromTunnel(r) {
		resp := h.tunnelResponse(r)
		if !resp.Enabled {
			resp.Status = tunnel.Status{State: tunnel.StateOff, SignedIn: resp.SignedIn}
		}
		answerThenStop(w, resp, func() {
			h.applyTunnelSettings()
			publishEvent(eventSettingsChanged, "tunnel")
		})
		return
	}
	h.applyTunnelSettings()
	publishEvent(eventSettingsChanged, "tunnel")
	json.NewEncoder(w).Encode(h.tunnelResponse(r))
}

func (h *Handler) apiTunnelLogout(w http.ResponseWriter, r *http.Request) {
	settings := config.GetTunnelSettings()
	settings.Enabled = false
	if err := config.UpdateTunnelSettings(settings); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if h.tunnel != nil && tunnel.FromTunnel(r) {
		// The sign-out stops the helper this answer goes through, so it runs after the answer
		// and can only report a failure to the log.
		resp := h.tunnelResponse(r)
		resp.Status = tunnel.Status{State: tunnel.StateOff}
		answerThenStop(w, resp, func() {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			if err := h.tunnel.Logout(ctx); err != nil {
				logger.Warnf("[Tunnel] Sign-out: %v", err)
			} else {
				logger.Infof("[Tunnel] Signed out of Tailscale")
			}
			publishEvent(eventSettingsChanged, "tunnel")
		})
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
	json.NewEncoder(w).Encode(h.tunnelResponse(r))
}

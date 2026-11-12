package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/proxypool"
)

// Admin API codes of the proxy pool routes.
const (
	codeProxyPoolInvalid   = "proxy_pool_invalid"
	codeProxyPoolDuplicate = "proxy_pool_duplicate"
	codeProxyPoolNotFound  = "proxy_pool_not_found"
	codeProxyPoolEmpty     = "proxy_pool_empty"
	codeProxyPoolFull      = "proxy_pool_full"
)

const (
	proxyPoolBodyLimit = 64 << 10
	// proxyPoolCheckAllWait is how long "Check all" waits before it answers; the
	// checks still running finish in the background and arrive as settings_changed.
	proxyPoolCheckAllWait = 15 * time.Second
)

// handleProxyPoolAPI serves /admin/api/proxy-pool/...; sub is the path after /proxy-pool.
// Every answer is the masked view: a password is write-only.
func (h *Handler) handleProxyPoolAPI(w http.ResponseWriter, r *http.Request, sub string) {
	r.Body = http.MaxBytesReader(w, r.Body, proxyPoolBodyLimit)
	switch {
	case (sub == "" || sub == "/") && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(proxypool.Default().View())
	case sub == "/settings" && (r.Method == http.MethodPut || r.Method == http.MethodPost):
		h.apiUpdateProxyPoolSettings(w, r)
	case sub == "/check" && r.Method == http.MethodPost:
		h.apiCheckProxyPool(w, r)
	case sub == "/proxies" && r.Method == http.MethodPost:
		h.apiAddPoolProxy(w, r)
	case strings.HasPrefix(sub, "/proxies/") && strings.HasSuffix(sub, "/check") && r.Method == http.MethodPost:
		h.apiCheckPoolProxy(w, r, strings.TrimSuffix(strings.TrimPrefix(sub, "/proxies/"), "/check"))
	case strings.HasPrefix(sub, "/proxies/") && r.Method == http.MethodPut:
		h.apiUpdatePoolProxy(w, r, strings.TrimPrefix(sub, "/proxies/"))
	case strings.HasPrefix(sub, "/proxies/") && r.Method == http.MethodDelete:
		h.apiDeletePoolProxy(w, strings.TrimPrefix(sub, "/proxies/"))
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

type poolProxyRequest struct {
	Label    *string `json:"label"`
	URL      *string `json:"url"`
	Username *string `json:"username"`
	Password *string `json:"password"`
}

func (req poolProxyRequest) input() proxypool.ProxyInput {
	return proxypool.ProxyInput{Label: req.Label, URL: req.URL, Username: req.Username, Password: req.Password}
}

func writeProxyPoolError(w http.ResponseWriter, err error) {
	var inputErr *proxypool.InputError
	switch {
	case errors.As(err, &inputErr):
		writeAdminErrorDetail(w, http.StatusBadRequest, codeProxyPoolInvalid, err.Error(), inputErr.Reason)
	case errors.Is(err, proxypool.ErrDuplicate):
		writeAdminError(w, http.StatusConflict, codeProxyPoolDuplicate, err.Error())
	case errors.Is(err, proxypool.ErrFull):
		writeAdminError(w, http.StatusBadRequest, codeProxyPoolFull, err.Error())
	case errors.Is(err, proxypool.ErrNotFound):
		writeAdminError(w, http.StatusNotFound, codeProxyPoolNotFound, err.Error())
	case errors.Is(err, config.ErrProxyPoolMode), errors.Is(err, config.ErrProxyPoolCheckInterval):
		writeAdminErrorDetail(w, http.StatusBadRequest, codeProxyPoolInvalid, err.Error(), err.Error())
	default:
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	}
}

func decodeProxyPoolBody(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return false
	}
	return true
}

func (h *Handler) apiUpdateProxyPoolSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode             *string `json:"mode"`
		DirectFallback   *bool   `json:"directFallback"`
		CheckIntervalMin *int    `json:"checkIntervalMin"`
	}
	if !decodeProxyPoolBody(w, r, &req) {
		return
	}
	turningOn := req.Mode != nil && *req.Mode == config.ProxyPoolModeOn && config.GetProxyPoolMode() != config.ProxyPoolModeOn
	if turningOn && len(config.GetProxyPool()) == 0 {
		writeAdminError(w, http.StatusBadRequest, codeProxyPoolEmpty, "add a proxy to the pool before turning it on")
		return
	}
	if err := config.UpdateProxyPoolSettings(req.Mode, req.DirectFallback, req.CheckIntervalMin); err != nil {
		writeProxyPoolError(w, err)
		return
	}
	if turningOn {
		//! Proxies never checked count as healthy; check them now instead of at the first tick.
		proxypool.Default().StartCheckAll()
	}
	publishEvent(eventSettingsChanged, "proxy-pool")
	json.NewEncoder(w).Encode(proxypool.Default().View())
}

func (h *Handler) apiAddPoolProxy(w http.ResponseWriter, r *http.Request) {
	var req poolProxyRequest
	if !decodeProxyPoolBody(w, r, &req) {
		return
	}
	p, err := proxypool.Default().Add(req.input())
	if err != nil {
		writeProxyPoolError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"proxy": proxypool.Default().ViewProxy(p)})
}

func (h *Handler) apiUpdatePoolProxy(w http.ResponseWriter, r *http.Request, id string) {
	var req poolProxyRequest
	if !decodeProxyPoolBody(w, r, &req) {
		return
	}
	p, err := proxypool.Default().Update(id, req.input())
	if err != nil {
		writeProxyPoolError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"proxy": proxypool.Default().ViewProxy(p)})
}

func (h *Handler) apiDeletePoolProxy(w http.ResponseWriter, id string) {
	if err := proxypool.Default().Remove(id); err != nil {
		writeProxyPoolError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiCheckPoolProxy(w http.ResponseWriter, r *http.Request, id string) {
	if _, err := proxypool.Default().CheckOne(r.Context(), id); err != nil {
		writeProxyPoolError(w, err)
		return
	}
	for _, p := range config.GetProxyPool() {
		if p.ID == id {
			json.NewEncoder(w).Encode(map[string]any{"proxy": proxypool.Default().ViewProxy(p)})
			return
		}
	}
	writeProxyPoolError(w, proxypool.ErrNotFound)
}

func (h *Handler) apiCheckProxyPool(w http.ResponseWriter, r *http.Request) {
	done := proxypool.Default().StartCheckAll()
	wait, cancel := context.WithTimeout(r.Context(), proxyPoolCheckAllWait)
	defer cancel()
	select {
	case <-done:
	case <-wait.Done():
	}
	json.NewEncoder(w).Encode(proxypool.Default().View())
}

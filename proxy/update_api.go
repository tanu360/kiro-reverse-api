package proxy

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"time"

	"kiro-proxy/updater"
)

// Self-update (the update dialog): GET and POST /admin/api/update, and POST
// /admin/api/update/restart. updater.Manager downloads and installs the release; restarting
// into it is main's job, since only main holds the HTTP server, the tunnel and the database.

const (
	codeUpdateVersion     = "update_version"
	codeUpdateUnsupported = "update_unsupported"
	codeUpdateBusy        = "update_busy"
	codeUpdateNotReady    = "update_not_ready"
)

// updateRestartDelay lets the restart's answer reach the browser before the server stops.
var updateRestartDelay = 300 * time.Millisecond

// SetUpdater attaches the self-updater and the function that restarts the server into the
// installed update. restart does not return when it succeeds.
func (h *Handler) SetUpdater(u *updater.Manager, restart func()) {
	h.updater = u
	h.restart = restart
}

// ExportAdminSessions returns the admin's sign-ins for the process a restart runs next, or nil.
func (h *Handler) ExportAdminSessions() []byte {
	return h.adminSessions.Export()
}

// ImportAdminSessions takes the sign-ins ExportAdminSessions gave the previous process and
// returns how many are still valid.
func (h *Handler) ImportAdminSessions(data []byte) int {
	return h.adminSessions.Import(data)
}

// ExportUserSessions and ImportUserSessions carry the user panel's sign-ins across a restart
// into an update, as the admin's are.
func (h *Handler) ExportUserSessions() []byte {
	return h.userSessions.Export()
}

func (h *Handler) ImportUserSessions(data []byte) int {
	return h.userSessions.Import(data)
}

// CloseEventStreams ends every open /events stream, so a shutdown does not wait on them. The
// pages reconnect to the restarted server on their own.
func (h *Handler) CloseEventStreams() {
	getBroadcaster().closeAll()
}

// updateProgressGap spaces the download's progress events: the updater reports every percent.
const updateProgressGap = 250 * time.Millisecond

// lastUpdateProgress is when the last progress event went out, in Unix nanoseconds.
var lastUpdateProgress atomic.Int64

// UpdateChanged publishes update_changed for each new status of the update, so the dialog
// follows without polling. Download progress publishes at most every updateProgressGap, and
// always at 100 percent.
func UpdateChanged(st updater.Status) {
	if st.State == updater.StateDownloading && st.Progress != nil && *st.Progress < 100 {
		now := time.Now().UnixNano()
		last := lastUpdateProgress.Load()
		if now-last < int64(updateProgressGap) || !lastUpdateProgress.CompareAndSwap(last, now) {
			return
		}
	}
	publishEvent(eventUpdateChanged, "")
}

// updateStatus is the status a server without an updater reports: it cannot update itself.
func (h *Handler) updateStatus() updater.Status {
	if h.updater == nil {
		return updater.Status{State: updater.StateIdle, Reason: updater.ReasonPlatform}
	}
	return h.updater.Status()
}

func (h *Handler) handleUpdateAPI(w http.ResponseWriter, r *http.Request, path string) {
	switch {
	case path == "" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(h.updateStatus())
	case path == "" && r.Method == http.MethodPost:
		h.apiStartUpdate(w, r)
	case path == "/restart" && r.Method == http.MethodPost:
		h.apiRestartUpdate(w)
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

func (h *Handler) apiStartUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if h.updater == nil {
		writeAdminError(w, http.StatusConflict, codeUpdateUnsupported, "This server cannot update itself.")
		return
	}
	started, err := h.updater.Start(req.Version)
	switch {
	case errors.Is(err, updater.ErrUnsupported):
		writeAdminError(w, http.StatusConflict, codeUpdateUnsupported, err.Error())
		return
	case errors.Is(err, updater.ErrBusy):
		writeAdminError(w, http.StatusConflict, codeUpdateBusy, err.Error())
		return
	case err != nil:
		// Start's only other error is updater.ErrVersion.
		writeAdminError(w, http.StatusBadRequest, codeUpdateVersion, err.Error())
		return
	}
	if started {
		w.WriteHeader(http.StatusAccepted)
	}
	json.NewEncoder(w).Encode(h.updater.Status())
}

func (h *Handler) apiRestartUpdate(w http.ResponseWriter) {
	if h.updater == nil || h.restart == nil {
		writeAdminError(w, http.StatusConflict, codeUpdateNotReady, "No update is ready to install.")
		return
	}
	st, ok := h.updater.BeginRestart()
	if !ok {
		writeAdminError(w, http.StatusConflict, codeUpdateNotReady, "No update is ready to install; download one first.")
		return
	}
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(st)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	restart := h.restart
	go func() {
		time.Sleep(updateRestartDelay)
		restart()
	}()
}

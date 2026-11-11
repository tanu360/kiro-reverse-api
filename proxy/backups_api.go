package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const (
	backupKeepMin = 1
	//! Matches KEEP_MAX in ui/src/features/backups/backup-model.ts.
	backupKeepMax = 200
)

// writeBackupError answers 404 for an unknown backup, 400 with a code for a
// file the restore cannot read, and 500 for everything else (I/O, database).
func writeBackupError(w http.ResponseWriter, err error) {
	var fileErr *config.BackupFileError
	switch {
	case errors.Is(err, config.ErrBackupNotFound):
		writeAdminError(w, http.StatusNotFound, codeBackupNotFound, err.Error())
	case errors.As(err, &fileErr):
		//! The parse failure is the detail the UI shows under its "not a usable backup" text.
		writeAdminErrorDetail(w, http.StatusBadRequest, fileErr.Code, err.Error(), err.Error())
	default:
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	}
}

func (h *Handler) apiBackupsList(w http.ResponseWriter, r *http.Request) {
	autoInclude := r.URL.Query().Get("autoInclude") == "true"
	list, err := config.ListBackups(autoInclude)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"backups": list})
}

func (h *Handler) apiBackupsCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind string `json:"kind"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if req.Kind == "" {
		req.Kind = "manual"
	}
	entry, err := config.CreateBackup(req.Kind, req.Note)
	if err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	publishEvent(eventBackupCreated, entry.ID)
	json.NewEncoder(w).Encode(map[string]interface{}{"backup": entry})
}

func (h *Handler) apiBackupsGet(w http.ResponseWriter, _ *http.Request, id string) {
	entry, err := config.FindBackup(id)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"backup": entry})
}

func (h *Handler) apiBackupsDownload(w http.ResponseWriter, _ *http.Request, id string) {
	entry, data, err := config.ReadBackupBytes(id)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"kiro-backup-%s.json\"", entry.ID))
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
	w.Write(data)
}

func (h *Handler) apiBackupsRestore(w http.ResponseWriter, _ *http.Request, id string) {
	if err := config.RestoreBackup(id); err != nil {
		writeBackupError(w, err)
		return
	}
	h.adminSessions.RevokeAll()
	h.pool.Reload()
	publishEvent(eventBackupRestored, id)
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiBackupsDelete(w http.ResponseWriter, _ *http.Request, id string) {
	if err := config.DeleteBackup(id); err != nil {
		writeBackupError(w, err)
		return
	}
	publishEvent(eventBackupDeleted, id)
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (h *Handler) apiBackupsRestoreUpload(w http.ResponseWriter, r *http.Request) {
	var data []byte
	var note string
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeAdminError(w, http.StatusBadRequest, codeBackupUploadFailed, "Failed to parse multipart")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, codeBackupUploadFailed, "No file uploaded")
			return
		}
		defer file.Close()
		note = header.Filename
		data, err = io.ReadAll(file)
		if err != nil {
			writeAdminError(w, http.StatusInternalServerError, codeBackupUploadFailed, "Failed to read file")
			return
		}
	} else {
		var err error
		data, err = io.ReadAll(r.Body)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, codeBackupUploadFailed, "Failed to read body")
			return
		}
		note = "uploaded"
	}
	if err := config.RestoreFromBytes(data, note); err != nil {
		writeBackupError(w, err)
		return
	}
	h.adminSessions.RevokeAll()
	h.pool.Reload()
	publishEvent(eventBackupRestored, "upload")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// backupScheduleView is the schedule as GET and POST /backups/schedule return
// it. Unset fields are omitted, so a never-configured schedule is
// {"keep":50}: keep is always the number of scheduled backups actually kept.
type backupScheduleView struct {
	Enabled bool   `json:"enabled,omitempty"`
	Cadence string `json:"cadence,omitempty"`
	Keep    int    `json:"keep,omitempty"`
	LastRun int64  `json:"lastRun,omitempty"`
	// NextRun is when the scheduler will take the next backup, unix seconds; omitted while disabled.
	NextRun int64 `json:"nextRun,omitempty"`
}

func scheduleView(sched config.BackupSchedule, now time.Time) backupScheduleView {
	return backupScheduleView{
		Enabled: sched.Enabled,
		Cadence: sched.Cadence,
		Keep:    sched.EffectiveKeep(),
		LastRun: sched.LastRun,
		NextRun: nextScheduledBackup(sched, now),
	}
}

func (h *Handler) apiBackupsScheduleGet(w http.ResponseWriter, _ *http.Request) {
	sched := config.GetBackupSchedule()
	json.NewEncoder(w).Encode(map[string]interface{}{"schedule": scheduleView(sched, time.Now())})
}

func (h *Handler) apiBackupsScheduleUpdate(w http.ResponseWriter, r *http.Request) {
	var sched config.BackupSchedule
	if err := json.NewDecoder(r.Body).Decode(&sched); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	//! The scheduler skips an unknown cadence without a word, so it never reaches config.
	if backupInterval(sched.Cadence) == 0 {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "cadence must be hourly, daily or weekly", "code": "invalid_cadence"})
		return
	}
	//! The old UI never enforced its max, so a stored keep above it stays valid while it is sent back unchanged.
	legacyKeep := sched.Keep > backupKeepMax && sched.Keep == config.GetBackupSchedule().Keep
	if (sched.Keep < backupKeepMin || sched.Keep > backupKeepMax) && !legacyKeep {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("keep must be between %d and %d", backupKeepMin, backupKeepMax), "code": "invalid_keep"})
		return
	}

	if err := config.UpdateBackupSchedule(sched); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	resp := map[string]interface{}{}
	//! A schedule that is off never prunes, as before. One that is on prunes now, not at its
	//! next run, so a lowered keep takes effect at once and a failed prune is retried on the next save.
	if sched.Enabled {
		removed, err := config.PruneScheduled()
		if removed > 0 {
			publishEvent(eventBackupDeleted, "*")
		}
		if err != nil {
			//! The schedule is saved; answering 500 would tell the admin it was not.
			logger.Warnf("[Backup] Prune scheduled backups failed: %v", err)
			resp["pruneError"] = err.Error()
		}
	}
	resp["schedule"] = scheduleView(config.GetBackupSchedule(), time.Now())
	json.NewEncoder(w).Encode(resp)
}

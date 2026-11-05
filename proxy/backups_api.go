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
)

const (
	backupKeepMin = 1
	//! Matches KEEP_MAX in ui/src/features/backups/backup-model.ts.
	backupKeepMax = 200
	// backupKeepDefault is what PruneScheduled keeps when keep was never set.
	backupKeepDefault = 50
)

// writeBackupError answers 404 for an unknown backup, 400 with a code for a
// file the restore cannot read, and 500 for everything else (I/O, database).
func writeBackupError(w http.ResponseWriter, err error) {
	var fileErr *config.BackupFileError
	switch {
	case errors.Is(err, config.ErrBackupNotFound):
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error(), "code": "backup_not_found"})
	case errors.As(err, &fileErr):
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error(), "code": fileErr.Code})
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
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
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to parse multipart"})
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "No file uploaded"})
			return
		}
		defer file.Close()
		note = header.Filename
		data, err = io.ReadAll(file)
		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to read file"})
			return
		}
	} else {
		var err error
		data, err = io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to read body"})
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
// it. Unset fields are omitted, so a never-configured schedule is {}.
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
		Keep:    sched.Keep,
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
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}
	//! The scheduler skips an unknown cadence without a word, so it never reaches config.
	if backupInterval(sched.Cadence) == 0 {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "cadence must be hourly, daily or weekly", "code": "invalid_cadence"})
		return
	}
	if sched.Keep < backupKeepMin || sched.Keep > backupKeepMax {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("keep must be between %d and %d", backupKeepMin, backupKeepMax), "code": "invalid_keep"})
		return
	}

	previousKeep := config.GetBackupSchedule().Keep
	if previousKeep <= 0 {
		previousKeep = backupKeepDefault
	}
	if err := config.UpdateBackupSchedule(sched); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if sched.Keep < previousKeep {
		//! Prune now: waiting for the next scheduled run keeps rows the admin just asked to drop.
		if err := config.PruneScheduled(); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		publishEvent(eventBackupDeleted, "*")
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"schedule": scheduleView(config.GetBackupSchedule(), time.Now())})
}

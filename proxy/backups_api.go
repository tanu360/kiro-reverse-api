// Package proxy: admin API endpoints for backups tab.
package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"kiro-go/config"
)

// apiBackupsList GET /admin/api/backups?autoInclude=true
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

// apiBackupsCreate POST /admin/api/backups {kind, note}
func (h *Handler) apiBackupsCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind string `json:"kind"` // manual / scheduled
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
	getBroadcaster().Publish(Event{Type: "backup_created", Payload: entry.ID})
	json.NewEncoder(w).Encode(map[string]interface{}{"backup": entry})
}

// apiBackupsGet GET /admin/api/backups/{id}
func (h *Handler) apiBackupsGet(w http.ResponseWriter, r *http.Request, id string) {
	entry, err := config.FindBackup(id)
	if err != nil {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"backup": entry})
}

// apiBackupsDownload GET /admin/api/backups/{id}/download
func (h *Handler) apiBackupsDownload(w http.ResponseWriter, r *http.Request, id string) {
	entry, data, err := config.ReadBackupBytes(id)
	if err != nil {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"kiro-backup-%s.json\"", entry.ID))
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
	w.Write(data)
}

// apiBackupsRestore POST /admin/api/backups/{id}/restore
func (h *Handler) apiBackupsRestore(w http.ResponseWriter, r *http.Request, id string) {
	if err := config.RestoreBackup(id); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.pool.Reload()
	getBroadcaster().Publish(Event{Type: "backup_restored", Payload: id})
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// apiBackupsDelete DELETE /admin/api/backups/{id}
func (h *Handler) apiBackupsDelete(w http.ResponseWriter, r *http.Request, id string) {
	if err := config.DeleteBackup(id); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// apiBackupsRestoreUpload POST /admin/api/backups/restore (multipart or raw JSON body)
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
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	h.pool.Reload()
	getBroadcaster().Publish(Event{Type: "backup_restored", Payload: "upload"})
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// apiBackupsScheduleGet GET /admin/api/backups/schedule
func (h *Handler) apiBackupsScheduleGet(w http.ResponseWriter, r *http.Request) {
	sched := config.GetBackupSchedule()
	json.NewEncoder(w).Encode(map[string]interface{}{"schedule": sched})
}

// apiBackupsScheduleUpdate POST /admin/api/backups/schedule
func (h *Handler) apiBackupsScheduleUpdate(w http.ResponseWriter, r *http.Request) {
	var sched config.BackupSchedule
	if err := json.NewDecoder(r.Body).Decode(&sched); err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON"})
		return
	}
	if err := config.UpdateBackupSchedule(sched); err != nil {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

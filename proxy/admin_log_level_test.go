package proxy

import (
	"encoding/json"
	"net/http"
	"testing"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

func keepLogLevel(t *testing.T) {
	t.Helper()
	old := logger.GetLevel()
	t.Cleanup(func() { logger.SetLevel(old) })
}

func settingsLogLevel(t *testing.T, h *Handler) (string, bool) {
	t.Helper()
	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/settings", "")
	var body struct {
		LogLevel        string `json:"logLevel"`
		LogLevelFromEnv bool   `json:"logLevelFromEnv"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("GET /settings: %d %s", rec.Code, rec.Body.String())
	}
	return body.LogLevel, body.LogLevelFromEnv
}

// The image-resize check needs debug lines, and the level could only be set with LOG_LEVEL and
// a restart. POST /settings now switches it at once and keeps it for the next start.
func TestSettingsLogLevelAppliesLiveAndPersists(t *testing.T) {
	keepLogLevel(t)
	t.Setenv("LOG_LEVEL", "")
	h := newRegionTestAdmin(t)
	logger.SetLevel(logger.LevelInfo)

	if level, fromEnv := settingsLogLevel(t, h); level != "info" || fromEnv {
		t.Fatalf("GET before: level=%q fromEnv=%v", level, fromEnv)
	}
	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"logLevel":"DEBUG"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST debug: %d %s", rec.Code, rec.Body.String())
	}
	if logger.GetLevel() != logger.LevelDebug || config.GetLogLevel() != "debug" {
		t.Fatalf("after debug: logger=%v saved=%q", logger.GetLevel(), config.GetLogLevel())
	}
	if level, _ := settingsLogLevel(t, h); level != "debug" {
		t.Fatalf("GET after: level=%q", level)
	}

	// A bad level is refused before anything in the patch is saved.
	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"autoContinue":true,"logLevel":"loud"}`)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusBadRequest || body.Code != codeLogLevelInvalid {
		t.Fatalf("POST loud: %d %s", rec.Code, rec.Body.String())
	}
	if config.GetAutoContinue() || logger.GetLevel() != logger.LevelDebug {
		t.Fatalf("a refused patch changed autoContinue=%v or level=%v", config.GetAutoContinue(), logger.GetLevel())
	}

	// A patch without logLevel leaves it alone.
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"autoContinue":false}`); rec.Code != http.StatusOK || logger.GetLevel() != logger.LevelDebug {
		t.Fatalf("unrelated patch: %d level=%v", rec.Code, logger.GetLevel())
	}

	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"logLevel":"warn"}`); rec.Code != http.StatusOK || logger.GetLevel() != logger.LevelWarn {
		t.Fatalf("POST warn: %d level=%v", rec.Code, logger.GetLevel())
	}
	t.Setenv("LOG_LEVEL", "error")
	if level, fromEnv := settingsLogLevel(t, h); level != "warn" || !fromEnv {
		t.Fatalf("with LOG_LEVEL set: level=%q fromEnv=%v", level, fromEnv)
	}
}

// A restore brings back the backup's saved level. It applies at once, as at a start, so
// Settings shows the level the server now logs at.
func TestRestoreAppliesTheBackupsLogLevel(t *testing.T) {
	keepLogLevel(t)
	t.Setenv("LOG_LEVEL", "")
	h := newRegionTestAdmin(t)
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"logLevel":"debug"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST debug: %d %s", rec.Code, rec.Body.String())
	}
	backup, err := config.CreateBackup("manual", "with debug")
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/settings", `{"logLevel":"info"}`); rec.Code != http.StatusOK || logger.GetLevel() != logger.LevelInfo {
		t.Fatalf("POST info: %d level=%v", rec.Code, logger.GetLevel())
	}

	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/backups/"+backup.ID+"/restore", ""); rec.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	if level, _ := settingsLogLevel(t, h); level != "debug" || config.GetLogLevel() != "debug" {
		t.Fatalf("after restore: GET level=%q saved=%q", level, config.GetLogLevel())
	}

	// LOG_LEVEL still picks the level, as it does at a start.
	t.Setenv("LOG_LEVEL", "error")
	if rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/backups/"+backup.ID+"/restore", ""); rec.Code != http.StatusOK {
		t.Fatalf("restore with LOG_LEVEL: %d %s", rec.Code, rec.Body.String())
	}
	if logger.GetLevel() != logger.LevelError {
		t.Fatalf("with LOG_LEVEL=error after restore: level=%v", logger.GetLevel())
	}
}

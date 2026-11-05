package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
)

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func postSchedule(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.apiBackupsScheduleUpdate(rec, httptest.NewRequest(http.MethodPost, "/admin/api/backups/schedule", strings.NewReader(body)))
	return rec
}

func TestBackupScheduleValidatesAndReturnsNextRun(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}

	for _, body := range []string{
		`{"enabled":true,"cadence":"monthly","keep":10}`,
		`{"enabled":true,"cadence":"","keep":10}`,
		`{"enabled":true,"cadence":"daily","keep":0}`,
		`{"enabled":true,"cadence":"daily","keep":201}`,
	} {
		if rec := postSchedule(h, body); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", body, rec.Code)
		}
	}
	if got := config.GetBackupSchedule(); got.Cadence != "" || got.Keep != 0 {
		t.Fatalf("invalid schedule was saved: %+v", got)
	}

	before := time.Now()
	rec := postSchedule(h, `{"enabled":true,"cadence":"daily","keep":30}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status=%d body=%s", rec.Code, rec.Body.String())
	}
	sched := decodeJSON(t, rec)["schedule"].(map[string]interface{})
	if sched["enabled"] != true || sched["cadence"] != "daily" || sched["keep"].(float64) != 30 {
		t.Fatalf("schedule = %v", sched)
	}
	next := int64(sched["nextRun"].(float64))
	//! Never run: due now, so the next 5-minute tick.
	if next < before.Unix() || next > before.Add(backupTick).Unix() || next%int64(backupTick.Seconds()) != 0 {
		t.Fatalf("nextRun = %d, now = %d", next, before.Unix())
	}
}

func TestNextScheduledBackup(t *testing.T) {
	const tick = int64(1_700_000_100) // a multiple of 300 s
	now := time.Unix(tick+100, 0)
	daily := config.BackupSchedule{Enabled: true, Cadence: "daily", LastRun: tick - 3600}
	if got, want := nextScheduledBackup(daily, now), tick-3600+86400; got != want {
		t.Fatalf("daily nextRun = %d, want %d", got, want)
	}
	overdue := config.BackupSchedule{Enabled: true, Cadence: "hourly", LastRun: tick - 7200}
	if got, want := nextScheduledBackup(overdue, now), tick+300; got != want {
		t.Fatalf("overdue nextRun = %d, want %d", got, want)
	}
	if got := nextScheduledBackup(config.BackupSchedule{Cadence: "daily"}, now); got != 0 {
		t.Fatalf("disabled nextRun = %d, want 0", got)
	}
}

func TestBackupScheduleLoweringKeepPrunes(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}
	if rec := postSchedule(h, `{"enabled":true,"cadence":"daily","keep":5}`); rec.Code != http.StatusOK {
		t.Fatalf("save: status=%d", rec.Code)
	}
	for range 4 {
		if _, err := config.CreateBackup("scheduled", "auto-daily"); err != nil {
			t.Fatalf("create backup: %v", err)
		}
	}
	if rec := postSchedule(h, `{"enabled":true,"cadence":"daily","keep":2}`); rec.Code != http.StatusOK {
		t.Fatalf("lower keep: status=%d", rec.Code)
	}
	list, err := config.ListBackups(true)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	scheduled := 0
	for _, entry := range list {
		if entry.Kind == "scheduled" {
			scheduled++
		}
	}
	if scheduled != 2 {
		t.Fatalf("scheduled backups after lowering keep = %d, want 2", scheduled)
	}
}

func countScheduledBackups(t *testing.T) int {
	t.Helper()
	list, err := config.ListBackups(true)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	n := 0
	for _, entry := range list {
		if entry.Kind == "scheduled" {
			n++
		}
	}
	return n
}

func TestBackupScheduleOffNeverPrunesAndLegacyKeepSurvives(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}
	rec := httptest.NewRecorder()
	h.apiBackupsScheduleGet(rec, httptest.NewRequest(http.MethodGet, "/admin/api/backups/schedule", nil))
	if keep := decodeJSON(t, rec)["schedule"].(map[string]interface{})["keep"]; keep != float64(config.DefaultBackupKeep) {
		t.Fatalf("unset keep shows as %v, want the %d actually kept", keep, config.DefaultBackupKeep)
	}

	// A config the old UI wrote: keep 500, which its unenforced max let through.
	if err := config.UpdateBackupSchedule(config.BackupSchedule{Enabled: true, Cadence: "daily", Keep: 500}); err != nil {
		t.Fatalf("seed schedule: %v", err)
	}
	for range 3 {
		if _, err := config.CreateBackup("scheduled", "auto-daily"); err != nil {
			t.Fatalf("create backup: %v", err)
		}
	}
	if rec := postSchedule(h, `{"enabled":false,"cadence":"daily","keep":1}`); rec.Code != http.StatusOK {
		t.Fatalf("turn off: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if n := countScheduledBackups(t); n != 3 {
		t.Fatalf("turning the schedule off pruned to %d", n)
	}

	if err := config.UpdateBackupSchedule(config.BackupSchedule{Enabled: true, Cadence: "daily", Keep: 500}); err != nil {
		t.Fatalf("seed schedule: %v", err)
	}
	if rec := postSchedule(h, `{"enabled":true,"cadence":"weekly","keep":500}`); rec.Code != http.StatusOK {
		t.Fatalf("unchanged legacy keep: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := config.GetBackupSchedule(); got.Keep != 500 || got.Cadence != "weekly" {
		t.Fatalf("schedule = %+v", got)
	}
	if rec := postSchedule(h, `{"enabled":true,"cadence":"weekly","keep":300}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("a new keep above the max: status=%d, want 400", rec.Code)
	}
	if n := countScheduledBackups(t); n != 3 {
		t.Fatalf("an unchanged keep pruned to %d", n)
	}
}

func TestUntilBackupTickLandsOnTheWallClock(t *testing.T) {
	const tick = int64(1_700_000_100) // a multiple of 300 s
	for _, c := range []struct {
		now  time.Time
		want time.Duration
	}{
		{time.Unix(tick, 0), backupTick},
		{time.Unix(tick, int64(time.Second)), backupTick - time.Second},
		{time.Unix(tick-1, 0), time.Second},
	} {
		if got := untilBackupTick(c.now); got != c.want {
			t.Fatalf("untilBackupTick(%v) = %v, want %v", c.now, got, c.want)
		}
	}
}

func TestBackupErrorsUse404And400(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{adminSessions: newAdminSessionStore()}

	rec := httptest.NewRecorder()
	h.apiBackupsRestore(rec, httptest.NewRequest(http.MethodPost, "/admin/api/backups/nope/restore", nil), "nope")
	if rec.Code != http.StatusNotFound || decodeJSON(t, rec)["code"] != "backup_not_found" {
		t.Fatalf("restore unknown: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.apiBackupsDelete(rec, httptest.NewRequest(http.MethodDelete, "/admin/api/backups/nope", nil), "nope")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete unknown: status=%d body=%s", rec.Code, rec.Body.String())
	}

	for body, code := range map[string]string{
		`not json`:           config.BackupCodeInvalidJSON,
		`{"format":"other"}`: config.BackupCodeUnsupportedFormat,
		`{"format":"kiro-proxy-backup","version":9}`:             config.BackupCodeUnsupportedVersion,
		`{"format":"kiro-proxy-backup","version":1,"config":{}}`: config.BackupCodeSchemaMismatch,
	} {
		rec = httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/admin/api/backups/restore", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		h.apiBackupsRestoreUpload(rec, req)
		if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["code"] != code {
			t.Fatalf("upload %s: status=%d body=%s, want 400 %s", body, rec.Code, rec.Body.String(), code)
		}
	}
}

func TestBackupDeletePublishesEvent(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	entry, err := config.CreateBackup("manual", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)

	rec := httptest.NewRecorder()
	(&Handler{}).apiBackupsDelete(rec, httptest.NewRequest(http.MethodDelete, "/admin/api/backups/"+entry.ID, nil), entry.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if evt := waitForEvent(t, ch, eventBackupDeleted); evt.Payload != entry.ID {
		t.Fatalf("payload = %q, want %q", evt.Payload, entry.ID)
	}
}

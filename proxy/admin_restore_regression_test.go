package proxy

import (
	"bytes"
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPasswordUpdateRevokesSessionsForWhitespacePassword(t *testing.T) {
	h := newAdminAuthTestHandler(t, "original-password")
	token, _, err := h.adminSessions.Issue()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"password": "        "})
	req := httptest.NewRequest(http.MethodPost, "/admin/api/settings", bytes.NewReader(body))
	req.Header.Set("X-Admin-Token", token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update: %d", rec.Code)
	}
	if h.adminSessions.Valid(token) {
		t.Fatal("old session remains valid after password change")
	}
}

func TestBackupRestoreRevokesSessionsAndKeepsPasswordPrivate(t *testing.T) {
	for _, upload := range []bool{false, true} {
		name := "stored"
		if upload {
			name = "upload"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("ADMIN_PASSWORD", "")
			if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
				t.Fatal(err)
			}
			original := config.GetPassword()
			backup, err := config.CreateBackup("manual", "before first login")
			if err != nil {
				t.Fatal(err)
			}
			_, data, err := config.ReadBackupBytes(backup.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := config.UpdateSettingsPatch(nil, "replacement-password"); err != nil {
				t.Fatal(err)
			}
			h := NewHandler()
			token, _, err := h.adminSessions.Issue()
			if err != nil {
				t.Fatal(err)
			}
			ticket, _, err := h.adminSessions.IssueTicket()
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			if upload {
				h.apiBackupsRestoreUpload(rec, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(data)))
			} else {
				h.apiBackupsRestore(rec, httptest.NewRequest(http.MethodPost, "/", nil), backup.ID)
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
			}
			if config.GetPassword() != original {
				t.Fatal("backup password was not restored")
			}
			if h.adminSessions.Valid(token) {
				t.Error("old session survived restore")
			}
			if h.adminSessions.ConsumeTicket(ticket) {
				t.Error("old event ticket survived restore")
			}
			if firstRunPassword(t, h) != "" {
				t.Error("restore publicly exposed password")
			}
			if err := config.Load(); err != nil {
				t.Fatal(err)
			}
			if firstRunPassword(t, h) != "" {
				t.Error("restart publicly exposed restored password")
			}
		})
	}
}

package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/tunnel"
)

func TestPasswordUpdateRevokesSessionsForWhitespacePassword(t *testing.T) {
	h := newAdminAuthTestHandler(t, "original-password")
	token, _, err := h.adminSessions.Issue(false)
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
			if err := config.Init(tempDBPath(t)); err != nil {
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
			h := newHandlerWithoutBackgroundForTest(t)
			token, _, err := h.adminSessions.Issue(false)
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

// A restore brings back another password: a sign-in that passed the old one and waits for its
// two-factor code must end with the sessions.
func TestBackupRestoreEndsPendingTwoFactorSignIns(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	backup, err := config.CreateBackup("manual", "")
	if err != nil {
		t.Fatal(err)
	}
	h := newHandlerWithoutBackgroundForTest(t)
	challenge, _, err := h.totpState().issueChallenge(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.apiBackupsRestore(rec, httptest.NewRequest(http.MethodPost, "/", nil), backup.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	if h.totpState().challengeValid(challenge, time.Now()) {
		t.Fatal("a sign-in waiting for its code survived the restore")
	}
}

// A restore made through the public link answers before the link follows the restored settings:
// changing the link drops the connection the answer goes out on.
func TestBackupRestoreThroughTheLinkAnswersBeforeChangingIt(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateTunnelSettings(config.TunnelSettings{Enabled: true, Hostname: "box"}); err != nil {
		t.Fatal(err)
	}
	backup, err := config.CreateBackup("manual", "link on")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateTunnelSettings(config.TunnelSettings{Enabled: false, Hostname: "box"}); err != nil {
		t.Fatal(err)
	}
	h := newHandlerWithoutBackgroundForTest(t)
	h.tunnel = tunnel.New(tunnel.Options{DataDir: t.TempDir(), Binary: filepath.Join(t.TempDir(), "no-helper"), RestartMin: time.Hour, RestartMax: time.Hour})
	t.Cleanup(h.tunnel.Close)
	grace := tunnelAnswerGrace
	tunnelAnswerGrace = 50 * time.Millisecond
	t.Cleanup(func() { tunnelAnswerGrace = grace })

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req = req.WithContext(tunnel.WithTunnel(req.Context()))
	rec := httptest.NewRecorder()
	h.apiBackupsRestore(rec, req, backup.ID)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	if st := h.tunnel.Status(); st.State != tunnel.StateOff {
		t.Fatalf("the link changed to %q before the answer was out", st.State)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.tunnel.Status().State == tunnel.StateOff {
		if time.Now().After(deadline) {
			t.Fatal("the link never followed the restored settings")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

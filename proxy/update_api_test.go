package proxy

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/updater"
)

func setupUpdateTest(t *testing.T) *Handler {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	config.SetPassword("admin-password")
	return newHandlerWithoutBackgroundForTest(t)
}

// testUpdater returns an updater for a linux/amd64 server whose executable is a temp file, with
// releases at baseURL.
func testUpdater(t *testing.T, baseURL string, inContainer bool) *updater.Manager {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "kiro-proxy")
	if err := os.WriteFile(exe, []byte("old program"), 0o755); err != nil {
		t.Fatal(err)
	}
	return updater.New(updater.Options{
		Version:        config.Version,
		ReleaseBaseURL: baseURL,
		Executable:     func() (string, error) { return exe, nil },
		InContainer:    &inContainer,
		GOOS:           "linux",
		GOARCH:         "amd64",
		OnChange:       UpdateChanged,
	})
}

func updateErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if body["error"] == "" {
		t.Fatalf("no error message in %s", rec.Body.String())
	}
	return body["code"]
}

func waitForUpdate(t *testing.T, h *Handler, state updater.State) updater.Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		rec := adminRequest(t, h, http.MethodGet, "/update", "")
		var st updater.Status
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatal(err)
		}
		if st.State == state {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("update never reached %s: %+v", state, h.updater.Status())
	return updater.Status{}
}

func TestUpdateStatusShape(t *testing.T) {
	h := setupUpdateTest(t)
	h.SetUpdater(testUpdater(t, "http://127.0.0.1:1", true), func() {})

	rec := adminRequest(t, h, http.MethodGet, "/update", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["state"] != "idle" || body["supported"] != false || body["reason"] != "container" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if path, _ := body["path"].(string); !strings.HasSuffix(path, "kiro-proxy") {
		t.Fatalf("path = %v", body["path"])
	}
	for _, key := range []string{"version", "progress", "downloaded", "total", "error"} {
		if _, ok := body[key]; ok {
			t.Errorf("idle status carries %q: %s", key, rec.Body.String())
		}
	}
}

func TestUpdateRefusals(t *testing.T) {
	h := setupUpdateTest(t)
	unsupported := testUpdater(t, "http://127.0.0.1:1", true)
	supported := testUpdater(t, "http://127.0.0.1:1", false)
	tests := []struct {
		name    string
		updater *updater.Manager
		method  string
		path    string
		body    string
		status  int
		code    string
	}{
		{"unsupported", unsupported, http.MethodPost, "/update", `{"version":"99.0.0"}`, http.StatusConflict, codeUpdateUnsupported},
		{"no updater", nil, http.MethodPost, "/update", `{"version":"99.0.0"}`, http.StatusConflict, codeUpdateUnsupported},
		{"bad JSON", supported, http.MethodPost, "/update", `{`, http.StatusBadRequest, codeInvalidJSON},
		{"not a version", supported, http.MethodPost, "/update", `{"version":"latest"}`, http.StatusBadRequest, codeUpdateVersion},
		{"two numbers", supported, http.MethodPost, "/update", `{"version":"99.0"}`, http.StatusBadRequest, codeUpdateVersion},
		{"same version", supported, http.MethodPost, "/update", `{"version":"` + config.Version + `"}`, http.StatusBadRequest, codeUpdateVersion},
		{"older version", supported, http.MethodPost, "/update", `{"version":"0.0.1"}`, http.StatusBadRequest, codeUpdateVersion},
		{"restart before download", supported, http.MethodPost, "/update/restart", ``, http.StatusConflict, codeUpdateNotReady},
		{"restart unsupported", unsupported, http.MethodPost, "/update/restart", ``, http.StatusConflict, codeUpdateNotReady},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h.SetUpdater(tc.updater, func() { t.Error("a refused request restarted the server") })
			rec := adminRequest(t, h, tc.method, tc.path, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if code := updateErrorCode(t, rec); code != tc.code {
				t.Fatalf("code %q, want %q", code, tc.code)
			}
		})
	}
	if st := supported.Status(); st.State != updater.StateIdle {
		t.Fatalf("refused requests changed the status: %+v", st)
	}
}

func testRelease(t *testing.T, version, program string) http.Handler {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	name := "kiro-proxy-linux-x64/kiro-proxy"
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(program)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	tw.Write([]byte(program))
	tw.Close()
	zw.Close()
	archive := buf.Bytes()
	sum := sha256.Sum256(archive)
	mux := http.NewServeMux()
	mux.HandleFunc("/"+version+"/SHA256SUMS.txt", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%s  kiro-proxy-linux-x64.tar.gz\n", hex.EncodeToString(sum[:]))
	})
	mux.HandleFunc("/"+version+"/kiro-proxy-linux-x64.tar.gz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write(archive)
	})
	return mux
}

func TestUpdateDownloadThenRestart(t *testing.T) {
	h := setupUpdateTest(t)
	srv := httptest.NewServer(testRelease(t, "99.0.0", "new program"))
	defer srv.Close()
	u := testUpdater(t, srv.URL, false)
	restarted := make(chan struct{}, 1)
	h.SetUpdater(u, func() { restarted <- struct{}{} })
	defer func(d time.Duration) { updateRestartDelay = d }(updateRestartDelay)
	updateRestartDelay = 0

	rec := adminRequest(t, h, http.MethodPost, "/update", `{"version":"v99.0.0"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("start: status %d: %s", rec.Code, rec.Body.String())
	}
	var st updater.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Version != "99.0.0" || (st.State != updater.StateDownloading && st.State != updater.StateReady) {
		t.Fatalf("start answered %+v", st)
	}
	st = waitForUpdate(t, h, updater.StateReady)
	if st.Version != "99.0.0" || !st.Supported {
		t.Fatalf("ready: %+v", st)
	}

	// The same version again is a no-op.
	rec = adminRequest(t, h, http.MethodPost, "/update", `{"version":"99.0.0"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"ready"`) {
		t.Fatalf("repeat: status %d: %s", rec.Code, rec.Body.String())
	}

	rec = adminRequest(t, h, http.MethodPost, "/update/restart", "")
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"state":"restarting"`) {
		t.Fatalf("restart: status %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("restart was never called")
	}
	// A second click while restarting is refused.
	rec = adminRequest(t, h, http.MethodPost, "/update/restart", "")
	if rec.Code != http.StatusConflict || updateErrorCode(t, rec) != codeUpdateNotReady {
		t.Fatalf("second restart: status %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateBusyWhileDownloading(t *testing.T) {
	h := setupUpdateTest(t)
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		http.NotFound(w, r)
	}))
	defer srv.Close()
	h.SetUpdater(testUpdater(t, srv.URL, false), func() {})

	if rec := adminRequest(t, h, http.MethodPost, "/update", `{"version":"99.0.0"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("start: status %d: %s", rec.Code, rec.Body.String())
	}
	rec := adminRequest(t, h, http.MethodPost, "/update", `{"version":"99.0.1"}`)
	close(hold)
	if rec.Code != http.StatusConflict || updateErrorCode(t, rec) != codeUpdateBusy {
		t.Fatalf("second start: status %d: %s", rec.Code, rec.Body.String())
	}
	st := waitForUpdate(t, h, updater.StateError)
	if !strings.Contains(st.Error, "not on GitHub yet") {
		t.Fatalf("error = %q", st.Error)
	}
}

func TestUpdateChangedPublishesAnEvent(t *testing.T) {
	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)
	UpdateChanged(updater.Status{State: updater.StateReady, Version: "99.0.0"})
	select {
	case evt := <-ch:
		if evt.Type != "update_changed" {
			t.Fatalf("event = %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
}

func TestAdminSessionHandoffRoundTrip(t *testing.T) {
	src := newAdminSessionStore()
	if src.Export() != nil {
		t.Fatal("an empty store exported sessions")
	}
	live, _, err := src.Issue(false)
	if err != nil {
		t.Fatal(err)
	}
	ticket, _, err := src.IssueTicket()
	if err != nil {
		t.Fatal(err)
	}
	src.mu.Lock()
	src.sessions["expired-token"] = time.Now().Add(-time.Minute)
	src.mu.Unlock()

	data := src.Export()
	if strings.Contains(string(data), ticket) || strings.Contains(string(data), "expired-token") ||
		strings.Contains(string(data), live) {
		t.Fatalf("export carries a ticket, an expired session or a raw token: %s", data)
	}

	dst := newAdminSessionStore()
	if n := dst.Import(data); n != 1 {
		t.Fatalf("imported %d sessions, want 1", n)
	}
	if !dst.Valid(live) {
		t.Fatal("the live session did not survive the handoff")
	}
	if dst.ConsumeTicket(ticket) {
		t.Fatal("a ticket survived the handoff")
	}

	// A handoff written by hand (raw tokens, as releases before sessions were saved by hash
	// wrote): expired entries are dropped and none outlives the longest session TTL.
	now := time.Now()
	crafted, _ := json.Marshal([]sessionHandoff{
		{Token: "old", Expires: now.Add(-time.Second)},
		{Token: "forever", Expires: now.Add(100 * adminSessionTTL)},
		{Token: "", Expires: now.Add(time.Hour)},
	})
	dst = newAdminSessionStore()
	if n := dst.Import(crafted); n != 1 {
		t.Fatalf("imported %d sessions, want 1", n)
	}
	if dst.Valid("old") || !dst.Valid("forever") {
		t.Fatal("wrong sessions imported")
	}
	if expiry := dst.sessions[hashSessionToken("forever")]; expiry.After(time.Now().Add(adminRememberTTL)) {
		t.Fatalf("imported session expires %v, past the TTL", expiry)
	}
	if n := newAdminSessionStore().Import([]byte("not json")); n != 0 {
		t.Fatalf("garbage imported %d sessions", n)
	}
}

package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"kiro-proxy/config"
)

// The update dialog picks the update method and the release archive from this answer, so it
// must carry the server's own platform, not the browser's.
func TestVersionReportsServerPlatform(t *testing.T) {
	h := newRegionTestAdmin(t)
	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/version", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /version: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if body["version"] != config.Version || body["os"] != runtime.GOOS || body["arch"] != runtime.GOARCH {
		t.Fatalf("version answer = %v, want version %q os %q arch %q", body, config.Version, runtime.GOOS, runtime.GOARCH)
	}
	if docker, ok := body["docker"].(bool); !ok || docker != inContainer(containerMarkers) {
		t.Fatalf("docker = %v, want the bool %v", body["docker"], inContainer(containerMarkers))
	}

	// Still behind the admin sign-in.
	unauth := httptest.NewRecorder()
	h.ServeHTTP(unauth, httptest.NewRequest(http.MethodGet, "/admin/api/version", nil))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("GET /version without a password: %d, want 401", unauth.Code)
	}
}

func TestInContainerLooksForMarkerFiles(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, ".dockerenv")
	if inContainer([]string{missing}) {
		t.Fatal("no marker file, yet inContainer is true")
	}
	present := filepath.Join(dir, ".containerenv")
	if err := os.WriteFile(present, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !inContainer([]string{missing, present}) {
		t.Fatal("a marker file exists, yet inContainer is false")
	}
	if inContainer(nil) {
		t.Fatal("no markers, yet inContainer is true")
	}
}

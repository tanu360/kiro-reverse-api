package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const testIndexHTML = `<!doctype html><html><head><title>Kiro admin</title></head><body><div id="root"></div></body></html>`

func testAdminDist() fstest.MapFS {
	return fstest.MapFS{
		".keep":                   {Data: []byte{}},
		"index.html":              {Data: []byte(testIndexHTML)},
		"favicon.ico":             {Data: []byte("ICO-BYTES")},
		"icon.png":                {Data: []byte("PNG-BYTES")},
		"assets/index-abc123.js":  {Data: []byte("console.log('app')")},
		"assets/index-def456.css": {Data: []byte("body{}")},
	}
}

func serveAdminUI(h http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func assertIndexResponse(t *testing.T, rec *httptest.ResponseRecorder, target string) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: status %d, want 200", target, rec.Code)
	}
	if got := rec.Body.String(); got != testIndexHTML {
		t.Fatalf("%s: body %q, want the index document", target, got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("%s: Content-Type %q, want text/html", target, got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("%s: Cache-Control %q, want no-cache", target, got)
	}
}

// withAdminUI swaps the embedded admin UI for a fixture so tests that go through
// Handler.ServeHTTP do not depend on whether ui/dist was built locally.
func withAdminUI(t *testing.T, ui http.Handler) {
	t.Helper()
	previous := defaultAdminUI
	defaultAdminUI = func() http.Handler { return ui }
	t.Cleanup(func() { defaultAdminUI = previous })
}

func TestAdminUIServesIndex(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, target := range []string{"/admin", "/admin/"} {
		assertIndexResponse(t, serveAdminUI(h, http.MethodGet, target), target)
	}

	rec := serveAdminUI(h, http.MethodHead, "/admin/")
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD /admin/: status %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD /admin/: wrote a %d-byte body", rec.Body.Len())
	}
}

func TestAdminUIDeepLinkFallback(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, target := range []string{"/admin/accounts", "/admin/requests?page=2", "/admin/accounts/abc/detail"} {
		assertIndexResponse(t, serveAdminUI(h, http.MethodGet, target), target)
	}
}

func TestAdminUIAssetCacheHeaders(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)

	rec := serveAdminUI(h, http.MethodGet, "/admin/assets/index-abc123.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("asset: status %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "console.log('app')" {
		t.Fatalf("asset: body %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset: Cache-Control %q, want immutable", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "javascript") {
		t.Fatalf("asset: Content-Type %q, want a JavaScript type", got)
	}

	for _, target := range []string{"/admin/assets/missing.js", "/admin/assets/", "/admin/assets/nested/missing.css"} {
		rec := serveAdminUI(h, http.MethodGet, target)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), testIndexHTML) {
			t.Fatalf("%s: fell back to the index for a missing asset", target)
		}
		if got := rec.Header().Get("Cache-Control"); strings.Contains(got, "immutable") {
			t.Fatalf("%s: a 404 must not be cached as immutable, got %q", target, got)
		}
	}
}

func TestAdminUISPARouteWithoutSlash(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	withAdminUI(t, newAdminUIHandler(testAdminDist(), true))
	h := newHandlerWithoutBackgroundForTest(t)

	assertIndexResponse(t, serveAdminUI(h, http.MethodGet, "/admin/api"), "/admin/api")

	rec := serveAdminUI(h, http.MethodGet, "/admin/api/status")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("/admin/api/status: status %d, want 401 from the admin API", rec.Code)
	}
	if strings.Contains(rec.Body.String(), testIndexHTML) {
		t.Fatal("/admin/api/status was served by the admin UI")
	}
}

func TestAdminUIRootFile(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)

	rec := serveAdminUI(h, http.MethodGet, "/admin/favicon.ico")
	if rec.Code != http.StatusOK {
		t.Fatalf("favicon: status %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "ICO-BYTES" {
		t.Fatalf("favicon: body %q, want the file, not the index", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("favicon: Cache-Control %q, want no-cache", got)
	}

	// The index file itself is served in place, never redirected to the directory.
	assertIndexResponse(t, serveAdminUI(h, http.MethodGet, "/admin/index.html"), "/admin/index.html")
}

func TestAdminUIRejectsTraversal(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, target := range []string{
		"/admin/../go.mod",
		"/admin/%2e%2e/x",
		"/admin/%2e%2e/go.mod",
		"/admin/assets/../../go.mod",
		"/admin/./../handler.go",
	} {
		rec := serveAdminUI(h, http.MethodGet, target)
		body := rec.Body.String()
		switch rec.Code {
		case http.StatusOK:
			if body != testIndexHTML {
				t.Fatalf("%s: 200 with non-index body %q", target, body)
			}
		case http.StatusNotFound:
		default:
			t.Fatalf("%s: status %d, want index or 404", target, rec.Code)
		}
		if strings.Contains(body, "module kiro-proxy") || strings.Contains(body, "package proxy") {
			t.Fatalf("%s: served a file from outside the UI build", target)
		}
	}
}

func TestAdminUIMethodNotAllowed(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := serveAdminUI(h, method, "/admin/accounts")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /admin/accounts: status %d, want 405", method, rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "GET, HEAD" {
			t.Fatalf("%s /admin/accounts: Allow %q, want \"GET, HEAD\"", method, got)
		}
	}
}

func TestAdminUINotBuilt(t *testing.T) {
	h := newAdminUIHandler(fstest.MapFS{".keep": {Data: []byte{}}}, false)
	for _, target := range []string{"/admin", "/admin/", "/admin/accounts", "/admin/assets/index-abc123.js"} {
		rec := serveAdminUI(h, http.MethodGet, target)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status %d, want 503", target, rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "not built") {
			t.Fatalf("%s: body does not say the UI is not built: %q", target, body)
		}
		if !strings.Contains(body, "pnpm build") {
			t.Fatalf("%s: body does not explain how to build the UI", target)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
			t.Fatalf("%s: Content-Type %q, want text/html", target, got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s: Cache-Control %q, want no-store", target, got)
		}
	}
}

func TestAdminAPIUnaffected(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatal(err)
	}
	withAdminUI(t, newAdminUIHandler(testAdminDist(), true))
	h := newHandlerWithoutBackgroundForTest(t)

	rec := serveAdminUI(h, http.MethodGet, "/admin/api/status")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("/admin/api/status: status %d, want 401", rec.Code)
	}
	var unauthorized map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&unauthorized); err != nil {
		t.Fatalf("/admin/api/status: body is not JSON: %v", err)
	}
	if unauthorized["error"] != "Unauthorized" {
		t.Fatalf("/admin/api/status: body %v, want {\"error\":\"Unauthorized\"}", unauthorized)
	}

	rec = serveAdminUI(h, http.MethodGet, "/admin/api/first-run")
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/api/first-run: status %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("/admin/api/first-run: Content-Type %q, want JSON", got)
	}
	var firstRun map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&firstRun); err != nil {
		t.Fatalf("/admin/api/first-run: body is not JSON: %v", err)
	}
	if _, ok := firstRun["password"]; !ok {
		t.Fatalf("/admin/api/first-run: body %v has no password field", firstRun)
	}
}

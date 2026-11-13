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

// browserAccept is what a browser sends when it opens a page.
const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

// servePage requests target the way a browser opening it does.
func servePage(h http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("Accept", browserAccept)
	h.ServeHTTP(rec, req)
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

// assertPlainNotFound checks the proxy's plain 404, the answer an API client always got.
func assertPlainNotFound(t *testing.T, rec *httptest.ResponseRecorder, target string) {
	t.Helper()
	if rec.Code != http.StatusNotFound {
		t.Fatalf("%s: status %d, want 404", target, rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "Not Found" {
		t.Fatalf("%s: body %q, want the plain Not Found", target, got)
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

func newRoutedHandlerForTest(t *testing.T) http.Handler {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatal(err)
	}
	withAdminUI(t, newAdminUIHandler(testAdminDist(), true))
	return newHandlerWithoutBackgroundForTest(t)
}

func TestAdminUIServesIndex(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	assertIndexResponse(t, servePage(h, http.MethodGet, "/"), "/")

	rec := servePage(h, http.MethodHead, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD /: status %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD /: wrote a %d-byte body", rec.Body.Len())
	}
}

func TestAdminUIDeepLinkFallback(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, target := range []string{"/accounts", "/requests?page=2", "/accounts/abc/detail", "/api"} {
		assertIndexResponse(t, servePage(h, http.MethodGet, target), target)
		// Only a page load falls back to the app; an API client gets the plain 404.
		assertPlainNotFound(t, serveAdminUI(h, http.MethodGet, target), target+" (no Accept)")
	}
}

func TestAdminUIAssetCacheHeaders(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)

	rec := serveAdminUI(h, http.MethodGet, "/assets/index-abc123.js")
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

	for _, target := range []string{"/assets/missing.js", "/assets/", "/assets/nested/missing.css"} {
		rec := servePage(h, http.MethodGet, target)
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

func TestAdminUIRootFile(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)

	rec := serveAdminUI(h, http.MethodGet, "/favicon.ico")
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
	assertIndexResponse(t, serveAdminUI(h, http.MethodGet, "/index.html"), "/index.html")
}

func TestAdminUIRejectsTraversal(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, target := range []string{
		"/../go.mod",
		"/%2e%2e/x",
		"/%2e%2e/go.mod",
		"/assets/../../go.mod",
		"/./../handler.go",
	} {
		rec := servePage(h, http.MethodGet, target)
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

func TestAdminUIOtherMethodsAreNotFound(t *testing.T) {
	h := newAdminUIHandler(testAdminDist(), true)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		assertPlainNotFound(t, servePage(h, method, "/accounts"), method+" /accounts")
	}
}

func TestAdminUINotBuilt(t *testing.T) {
	h := newAdminUIHandler(fstest.MapFS{".keep": {Data: []byte{}}}, false)
	for _, target := range []string{"/", "/accounts", "/assets/index-abc123.js"} {
		rec := servePage(h, http.MethodGet, target)
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
	assertPlainNotFound(t, serveAdminUI(h, http.MethodGet, "/accounts"), "/accounts (no Accept)")
}

func TestRootServesUIToBrowsersAndHealthToClients(t *testing.T) {
	h := newRoutedHandlerForTest(t)

	assertIndexResponse(t, servePage(h, http.MethodGet, "/"), "/ (browser)")

	for _, target := range []string{"/", "/health"} {
		rec := serveAdminUI(h, http.MethodGet, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d, want 200", target, rec.Code)
		}
		var health map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&health); err != nil {
			t.Fatalf("%s: body is not the health JSON: %v", target, err)
		}
		if health["status"] != "ok" {
			t.Fatalf("%s: health %v, want status ok", target, health)
		}
	}
	// /health stays JSON for a browser too.
	if rec := servePage(h, http.MethodGet, "/health"); strings.Contains(rec.Body.String(), testIndexHTML) {
		t.Fatal("/health served the admin UI to a browser")
	}
}

func TestRootRoutesKeepTheProxyAPI(t *testing.T) {
	h := newRoutedHandlerForTest(t)

	// The API page is a UI route; the admin API under it is not.
	assertIndexResponse(t, servePage(h, http.MethodGet, "/api"), "/api")
	rec := servePage(h, http.MethodGet, "/admin/api/status")
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), testIndexHTML) {
		t.Fatalf("/admin/api/status: status %d, want 401 from the admin API", rec.Code)
	}

	// Unknown proxy paths stay a plain 404, even for a browser.
	assertPlainNotFound(t, servePage(h, http.MethodGet, "/v1/unknown"), "/v1/unknown")
	assertPlainNotFound(t, serveAdminUI(h, http.MethodPost, "/unknown"), "POST /unknown")

	// Proxy routes are matched before the UI, for a browser too.
	for _, target := range []string{"/v1/models", "/models"} {
		rec = servePage(h, http.MethodGet, target)
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("%s: Content-Type %q, want the proxy API's JSON", target, got)
		}
		if strings.Contains(rec.Body.String(), testIndexHTML) {
			t.Fatalf("%s: served the admin UI", target)
		}
	}
}

func TestLegacyAdminPagesRedirectToRoot(t *testing.T) {
	h := newRoutedHandlerForTest(t)
	for target, want := range map[string]string{
		"/admin":                        "/",
		"/admin/":                       "/",
		"/admin/accounts":               "/accounts",
		"/admin/accounts?status=failed": "/accounts?status=failed",
		"/admin/api":                    "/api",
		"/admin/assets/index-abc123.js": "/assets/index-abc123.js",
		"/admin//evil.example/":         "/evil.example/",
		"/admin///evil.example?next=/x": "/evil.example?next=/x",
	} {
		rec := servePage(h, http.MethodGet, target)
		if rec.Code != http.StatusMovedPermanently {
			t.Fatalf("%s: status %d, want 301", target, rec.Code)
		}
		if got := rec.Header().Get("Location"); got != want {
			t.Fatalf("%s: Location %q, want %q", target, got, want)
		}
	}

	// A backslash after /admin/ must not turn into a protocol-relative redirect either.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.URL.Path = "/admin/\\evil.example"
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Location"); got != "/evil.example" {
		t.Fatalf("/admin/\\evil.example: Location %q, want /evil.example", got)
	}

	assertPlainNotFound(t, serveAdminUI(h, http.MethodPost, "/admin/accounts"), "POST /admin/accounts")
}

func TestAdminAPIUnaffected(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := config.Init(tempDBPath(t)); err != nil {
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

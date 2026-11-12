package proxy

import (
	"bytes"
	"io/fs"
	"kiro-proxy/ui"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

const (
	adminUIAssetPrefix = "assets/"
	adminUIIndexFile   = "index.html"

	cacheNoCache   = "no-cache"
	cacheImmutable = "public, max-age=31536000, immutable"
)

// defaultAdminUI serves the admin UI embedded in the binary. Tests replace it with a fixture.
var defaultAdminUI = sync.OnceValue(func() http.Handler {
	d, ok := ui.Dist()
	return newAdminUIHandler(d, ok)
})

// adminUIHandler serves the admin single-page app at the site root. Hashed files under
// /assets/ are cached for a year; any other page a browser asks for falls back to index.html
// so the client router can resolve deep links. The proxy API, /admin/api/* and /health are
// routed before this handler, which only sees what nothing else matched.
type adminUIHandler struct {
	dist  fs.FS
	index []byte
}

func newAdminUIHandler(dist fs.FS, built bool) http.Handler {
	if !built {
		return adminUINotBuiltHandler{}
	}
	index, err := fs.ReadFile(dist, adminUIIndexFile)
	if err != nil {
		return adminUINotBuiltHandler{}
	}
	return &adminUIHandler{dist: dist, index: index}
}

// apiNotFound is the proxy's plain 404 for a path nothing serves, the body it always had.
func apiNotFound(w http.ResponseWriter) {
	http.Error(w, "Not Found", http.StatusNotFound)
}

// wantsHTML reports whether the request is a browser page load. Only those fall back to the
// app: an API client that hits an unknown path keeps getting a plain 404, not a web page.
func wantsHTML(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func (h *adminUIHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	//! The app shares the root with the proxy API: a POST to a path nothing serves is the
	//! API's plain 404, as before the UI moved here, never a 405 from the app.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		apiNotFound(w)
		return
	}

	rel := strings.TrimPrefix(r.URL.Path, "/")
	name := path.Clean(rel)
	if rel == "" {
		name = "."
	}
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}

	//! A missing hashed asset is a 404, never the index: a stale index.html would otherwise be
	//! cached as a script or stylesheet and break the page until the cache expires.
	if strings.HasPrefix(rel, adminUIAssetPrefix) {
		if !strings.HasPrefix(name, adminUIAssetPrefix) || !h.serveFile(w, r, name, cacheImmutable) {
			http.NotFound(w, r)
		}
		return
	}

	if name != "." && h.serveFile(w, r, name, cacheNoCache) {
		return
	}
	if !wantsHTML(r) {
		apiNotFound(w)
		return
	}
	h.serveIndex(w, r)
}

// serveFile writes the named file if it is a regular file in the build and reports whether it did.
func (h *adminUIHandler) serveFile(w http.ResponseWriter, r *http.Request, name, cacheControl string) bool {
	info, err := fs.Stat(h.dist, name)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	data, err := fs.ReadFile(h.dist, name)
	if err != nil {
		return false
	}
	if name == adminUIIndexFile {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	w.Header().Set("Cache-Control", cacheControl)
	//! ServeContent, not ServeFile: ServeFile redirects requests for index.html to the directory.
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	return true
}

func (h *adminUIHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", cacheNoCache)
	http.ServeContent(w, r, adminUIIndexFile, time.Time{}, bytes.NewReader(h.index))
}

// adminUINotBuiltHandler answers browser page loads when the binary was built without ui/dist.
type adminUINotBuiltHandler struct{}

const adminUINotBuiltPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiro Proxy admin UI not built</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}code{background:#161b22}}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}
</style>
</head>
<body>
<h1>Kiro Proxy admin UI not built</h1>
<p>This binary was built without the admin UI. The proxy API still works.</p>
<p>To build the UI, run <code>cd ui &amp;&amp; pnpm install &amp;&amp; pnpm build</code>, then rebuild the Go binary.</p>
<p>The Docker image always includes the UI.</p>
</body>
</html>
`

func (adminUINotBuiltHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if (r.Method != http.MethodGet && r.Method != http.MethodHead) || !wantsHTML(r) {
		apiNotFound(w)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	w.Write([]byte(adminUINotBuiltPage))
}

// redirectLegacyAdminPath moves a page URL from the old /admin/ base (a bookmark, an installed
// app's start URL) to the same page at the root, query kept. /admin/api/* is the admin API and
// never reaches this.
func redirectLegacyAdminPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		apiNotFound(w)
		return
	}
	//! Leading slashes and backslashes are dropped, so /admin//evil.example or /admin/\evil.example
	//! cannot become a protocol-relative redirect to another host.
	target := "/" + strings.TrimLeft(strings.TrimPrefix(r.URL.Path, "/admin"), "/\\")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	http.Redirect(w, r, target, http.StatusMovedPermanently)
}

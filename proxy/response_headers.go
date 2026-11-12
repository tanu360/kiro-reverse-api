package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	"kiro-proxy/config"
)

/*
 * Custom response headers (Settings > Response headers). Every client API response goes through
 * headerInjectingWriter, which adds the configured headers the moment the response starts: the
 * first WriteHeader, Write or Flush. That one place covers JSON, SSE, http.Error and auth errors.
 *
 * Variables resolve as late as possible, at that moment:
 *   - request_id, client_ip: always (set when the wrapper is made).
 *   - key_id: after API key auth; empty when keys are not required or auth failed.
 *   - model: the model the client asked for, once the body JSON parsed; empty before that and on
 *     /v1/models.
 *   - account_id: the account of the latest upstream call. A non-stream answer is final when its
 *     headers go out. A stream's headers go out with its first byte, after the retries before
 *     it, so that is the streaming account; a later web-search step that switches account
 *     cannot be shown. Empty for count_tokens, models and errors before any upstream call.
 */

const (
	maxResponseHeaderVarBytes = 256
	maxResponseHeaderOutBytes = 1024
)

// responseHeaderVars holds the variables of one client request. Handlers fill it through the
// note* helpers; the writer reads it once, when the response starts.
type responseHeaderVars struct {
	mu        sync.Mutex
	requestID string
	clientIP  string
	model     string
	accountID string
	keyID     string
}

type responseHeaderValues struct {
	requestID string
	clientIP  string
	model     string
	accountID string
	keyID     string
}

type responseHeaderVarsKey struct{}

func responseHeaderVarsFrom(ctx context.Context) *responseHeaderVars {
	if ctx == nil {
		return nil
	}
	vars, _ := ctx.Value(responseHeaderVarsKey{}).(*responseHeaderVars)
	return vars
}

func (v *responseHeaderVars) snapshot() responseHeaderValues {
	v.mu.Lock()
	defer v.mu.Unlock()
	return responseHeaderValues{
		requestID: v.requestID,
		clientIP:  v.clientIP,
		model:     v.model,
		accountID: v.accountID,
		keyID:     v.keyID,
	}
}

// newRequestID returns "req_" and 24 hex characters from crypto/rand.
func newRequestID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "req_" + hex.EncodeToString(b[:])
}

// requestIDFromContext is the proxy's id for this client request, or "" outside one.
func requestIDFromContext(ctx context.Context) string {
	vars := responseHeaderVarsFrom(ctx)
	if vars == nil {
		return ""
	}
	vars.mu.Lock()
	defer vars.mu.Unlock()
	return vars.requestID
}

// noteResponseModel records the model the client asked for. A no-op outside a client request.
func noteResponseModel(ctx context.Context, model string) {
	if vars := responseHeaderVarsFrom(ctx); vars != nil {
		vars.mu.Lock()
		vars.model = model
		vars.mu.Unlock()
	}
}

// noteResponseAccount records the account an upstream call is about to use. Failover calls it
// again, so the last account tried wins.
func noteResponseAccount(ctx context.Context, account *config.Account) {
	if account == nil {
		return
	}
	if vars := responseHeaderVarsFrom(ctx); vars != nil {
		vars.mu.Lock()
		vars.accountID = account.ID
		vars.mu.Unlock()
	}
}

// noteResponseKeyID records the API key that passed auth.
func noteResponseKeyID(ctx context.Context, keyID string) {
	if vars := responseHeaderVarsFrom(ctx); vars != nil {
		vars.mu.Lock()
		vars.keyID = keyID
		vars.mu.Unlock()
	}
}

// isClientAPIPath reports whether a path is a client API (not admin, health, UI or telemetry).
func isClientAPIPath(path string) bool {
	if requestEndpointForPath(path) != "" {
		return true
	}
	switch path {
	case "/messages/count_tokens", "/models", "/codex/models":
		return true
	}
	return strings.HasPrefix(path, "/v1/") || strings.HasPrefix(path, "/responses/")
}

// clientRemoteHost is the host part of RemoteAddr. X-Forwarded-For is not trusted (as for the
// admin login limit): any client can send it.
func clientRemoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// wrapClientResponse gives a client request its id and variables and wraps its writer. Call the
// returned finish after the handler: it adds the headers to a response the handler left empty.
func wrapClientResponse(w http.ResponseWriter, r *http.Request) (http.ResponseWriter, *http.Request, func()) {
	vars := &responseHeaderVars{requestID: newRequestID(), clientIP: clientRemoteHost(r)}
	r = r.WithContext(context.WithValue(r.Context(), responseHeaderVarsKey{}, vars))
	iw := &headerInjectingWriter{ResponseWriter: w, vars: vars}
	return iw, r, iw.commit
}

// headerInjectingWriter adds the custom headers once, when the response starts. It embeds the
// interface, so only Write can send bytes (no ReadFrom that would skip the injection).
type headerInjectingWriter struct {
	http.ResponseWriter
	vars *responseHeaderVars
	once sync.Once
}

func (w *headerInjectingWriter) WriteHeader(code int) {
	//! A 1xx is sent with the header map but does not start the response.
	if code >= 200 {
		w.commit()
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *headerInjectingWriter) Write(p []byte) (int, error) {
	w.commit()
	return w.ResponseWriter.Write(p)
}

func (w *headerInjectingWriter) Flush() {
	w.commit()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *headerInjectingWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *headerInjectingWriter) commit() {
	w.once.Do(w.inject)
}

func (w *headerInjectingWriter) inject() {
	rules := config.ActiveResponseHeaders()
	if len(rules) == 0 {
		return
	}
	values := w.vars.snapshot()
	header := w.ResponseWriter.Header()
	added := make([]string, 0, len(rules))
	for _, rule := range rules {
		//! A header the proxy set for this response (Retry-After, SSE Cache-Control, CORS) wins.
		if len(header.Values(rule.Name)) > 0 {
			continue
		}
		value := expandResponseHeaderTemplate(rule.Value, values)
		if value == "" {
			continue
		}
		header.Set(rule.Name, value)
		added = append(added, rule.Name)
	}
	exposeResponseHeaders(header, added)
}

// exposeResponseHeaders lets cross-origin browser clients read the added headers. Only a
// response that already has CORS headers is touched.
func exposeResponseHeaders(header http.Header, names []string) {
	exposed := header.Get("Access-Control-Expose-Headers")
	if exposed == "" || len(names) == 0 {
		return
	}
	listed := make(map[string]bool)
	for _, item := range strings.Split(exposed, ",") {
		listed[strings.ToLower(strings.TrimSpace(item))] = true
	}
	for _, name := range names {
		lower := strings.ToLower(name)
		if !listed[lower] {
			exposed += ", " + lower
			listed[lower] = true
		}
	}
	header.Set("Access-Control-Expose-Headers", exposed)
}

// expandResponseHeaderTemplate fills the {variable} placeholders in one pass. Unknown names and
// other braces stay as written; the result is trimmed and capped.
func expandResponseHeaderTemplate(template string, values responseHeaderValues) string {
	var out strings.Builder
	for rest := template; rest != ""; {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			out.WriteString(rest)
			break
		}
		out.WriteString(rest[:open])
		rest = rest[open:]
		if end := strings.IndexByte(rest, '}'); end > 0 {
			if value, ok := responseHeaderVariable(rest[1:end], values); ok {
				out.WriteString(sanitizeResponseHeaderValue(value, maxResponseHeaderVarBytes, false))
				rest = rest[end+1:]
				continue
			}
		}
		out.WriteByte('{')
		rest = rest[1:]
	}
	//! The saved template may hold HTAB (a valid field-value byte); keep it so the client sees what was saved.
	return strings.Trim(sanitizeResponseHeaderValue(out.String(), maxResponseHeaderOutBytes, true), " \t")
}

func responseHeaderVariable(name string, values responseHeaderValues) (string, bool) {
	switch name {
	case "request_id":
		return values.requestID, true
	case "model":
		return values.model, true
	case "account_id":
		return values.accountID, true
	case "key_id":
		return values.keyID, true
	case "client_ip":
		return values.clientIP, true
	}
	return "", false
}

// sanitizeResponseHeaderValue drops control characters (the model comes from the client), HTAB
// too unless keepTab, and cuts the text to max bytes on a UTF-8 boundary.
func sanitizeResponseHeaderValue(value string, max int, keepTab bool) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\t' && keepTab {
			return r
		}
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			return -1
		}
		return r
	}, value)
	if len(clean) <= max {
		return clean
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(clean[cut]) {
		cut--
	}
	return clean[:cut]
}

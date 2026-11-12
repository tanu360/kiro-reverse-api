package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"kiro-proxy/config"
)

var requestIDPattern = regexp.MustCompile(`^req_[0-9a-f]{24}$`)

// allResponseHeaderVars is one header per variable.
var allResponseHeaderVars = []config.ResponseHeaderRule{
	{Name: "X-Request-Id", Value: "{request_id}", Enabled: true},
	{Name: "X-Kiro-Model", Value: "{model}", Enabled: true},
	{Name: "X-Kiro-Account", Value: "{account_id}", Enabled: true},
	{Name: "X-Kiro-Key", Value: "{key_id}", Enabled: true},
	{Name: "X-Client-Ip", Value: "{client_ip}", Enabled: true},
}

func setTestResponseHeaders(t *testing.T, rules ...config.ResponseHeaderRule) {
	t.Helper()
	if err := config.UpdateResponseHeaders(rules); err != nil {
		t.Fatalf("set response headers: %v", err)
	}
}

// requireTestAPIKey turns API keys on and returns the bearer value and the key's id.
func requireTestAPIKey(t *testing.T) (string, string) {
	t.Helper()
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}
	entry, err := config.AddApiKey(config.ApiKeyEntry{Name: "headers", Key: "sk-headers-test", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	return entry.Key, entry.ID
}

func clientTestBody(t *testing.T, model string, stream bool) string {
	t.Helper()
	raw, err := json.Marshal(map[string]interface{}{
		"model": model, "max_tokens": 64, "stream": stream, "store": false, "input": "hi",
		"messages": []interface{}{map[string]interface{}{"role": "user", "content": "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func serveClient(h *Handler, method, path, key, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// sentHeaders is the header as it was when the response started, not as it ended.
func sentHeaders(rec *httptest.ResponseRecorder) http.Header {
	return rec.Result().Header
}

// newHeaderTestHandler is newStreamTestHandler with the shared account healthy before and after
// the test, and a models list cached so /v1/models never asks upstream.
func newHeaderTestHandler(t *testing.T, upstream http.HandlerFunc) *Handler {
	t.Helper()
	h := newStreamTestHandler(t, upstream)
	h.pool.RecordSuccess("only")
	t.Cleanup(func() { h.pool.RecordSuccess("only") })
	h.cachedModels = []ModelInfo{{ModelId: "claude-sonnet-4.5"}}
	return h
}

func textUpstream(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"}),
			meteringFrame(t),
		)
	}
}

func assertAllResponseHeaderVars(t *testing.T, header http.Header, model, account, keyID string) {
	t.Helper()
	if id := header.Get("X-Request-Id"); !requestIDPattern.MatchString(id) {
		t.Errorf("X-Request-Id = %q, want req_ and 24 hex", id)
	}
	for name, want := range map[string]string{
		"X-Kiro-Model":   model,
		"X-Kiro-Account": account,
		"X-Kiro-Key":     keyID,
		"X-Client-Ip":    "192.0.2.1",
	} {
		got, present := header.Get(name), len(header.Values(name)) > 0
		if want == "" && present {
			t.Errorf("%s = %q, want it left out (empty variable)", name, got)
		} else if got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestExpandResponseHeaderTemplate(t *testing.T) {
	values := responseHeaderValues{requestID: "req_1", model: "claude-sonnet-4.5", accountID: "acc-1", keyID: "key-1", clientIP: "203.0.113.9"}
	cases := []struct{ template, want string }{
		{"{request_id}", "req_1"},
		{"{model}|{account_id}|{key_id}|{client_ip}", "claude-sonnet-4.5|acc-1|key-1|203.0.113.9"},
		{"id={request_id};again={request_id}", "id=req_1;again=req_1"},
		{"static", "static"},
		{"{Model} {unknown} {} { {request_id", "{Model} {unknown} {} { {request_id"},
		{"{{request_id}}", "{req_1}"},
		{"a{b{model}c}d", "a{bclaude-sonnet-4.5c}d"},
		{"  {request_id}  ", "req_1"},
	}
	for _, tc := range cases {
		if got := expandResponseHeaderTemplate(tc.template, values); got != tc.want {
			t.Errorf("expand(%q) = %q, want %q", tc.template, got, tc.want)
		}
	}
	if got := expandResponseHeaderTemplate("{account_id}", responseHeaderValues{}); got != "" {
		t.Errorf("an empty variable must expand to nothing, got %q", got)
	}
	if got := expandResponseHeaderTemplate("  {account_id} ", responseHeaderValues{}); got != "" {
		t.Errorf("only whitespace around an empty variable must expand to nothing, got %q", got)
	}
}

func TestResponseHeaderVariableSanitized(t *testing.T) {
	model := "evil\r\nSet-Cookie: a=b\x00\x7f"
	if got := expandResponseHeaderTemplate("{model}", responseHeaderValues{model: model}); got != "evilSet-Cookie: a=b" {
		t.Fatalf("control characters must be dropped, got %q", got)
	}
	long := strings.Repeat("é", 200) // 400 bytes
	got := expandResponseHeaderTemplate("{model}", responseHeaderValues{model: long})
	if len(got) > maxResponseHeaderVarBytes || !strings.HasPrefix(long, got) || len(got) != 256 {
		t.Fatalf("variable must be cut to %d bytes on a rune boundary, got %d bytes", maxResponseHeaderVarBytes, len(got))
	}
	odd := "a" + strings.Repeat("é", 200)
	if got := expandResponseHeaderTemplate("{model}", responseHeaderValues{model: odd}); len(got) != 255 || !strings.HasPrefix(odd, got) {
		t.Fatalf("a cut inside a rune must step back to its start, got %d bytes", len(got))
	}
	all := expandResponseHeaderTemplate(strings.Repeat("{model}", 8), responseHeaderValues{model: strings.Repeat("m", 250)})
	if len(all) != maxResponseHeaderOutBytes {
		t.Fatalf("the whole value must be capped at %d bytes, got %d", maxResponseHeaderOutBytes, len(all))
	}
	if got := expandResponseHeaderTemplate("{model}", responseHeaderValues{model: "a\xffb"}); got != "ab" {
		t.Fatalf("invalid UTF-8 must be dropped, got %q", got)
	}
}

func TestIsClientAPIPath(t *testing.T) {
	for path, want := range map[string]bool{
		"/v1/messages":              true,
		"/anthropic/v1/messages":    true,
		"/messages":                 true,
		"/v1/messages/count_tokens": true,
		"/messages/count_tokens":    true,
		"/v1/chat/completions":      true,
		"/chat/completions":         true,
		"/v1/responses":             true,
		"/responses/resp_1":         true,
		"/v1/models":                true,
		"/models":                   true,
		"/codex/models":             true,
		"/v1/unknown":               true,
		"/admin/api/status":         false,
		"/health":                   false,
		"/":                         false,
		"/api/event_logging/batch":  false,
		"/assets/index.js":          false,
	} {
		if got := isClientAPIPath(path); got != want {
			t.Errorf("isClientAPIPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestResponseHeadersInjectedNonStream(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			h := newHeaderTestHandler(t, textUpstream(t))
			key, keyID := requireTestAPIKey(t)
			setTestResponseHeaders(t, allResponseHeaderVars...)

			rec := serveClient(h, http.MethodPost, path, key, clientTestBody(t, "claude-sonnet-4.5", false))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertAllResponseHeaderVars(t, sentHeaders(rec), "claude-sonnet-4.5", "only", keyID)
		})
	}
}

func TestResponseHeadersInjectedStream(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			h := newHeaderTestHandler(t, textUpstream(t))
			key, keyID := requireTestAPIKey(t)
			setTestResponseHeaders(t, allResponseHeaderVars...)

			rec := serveClient(h, http.MethodPost, path, key, clientTestBody(t, "claude-sonnet-4.5-thinking", true))
			header := sentHeaders(rec)
			if rec.Code != http.StatusOK || !strings.HasPrefix(header.Get("Content-Type"), "text/event-stream") {
				t.Fatalf("status=%d type=%q body=%s", rec.Code, header.Get("Content-Type"), rec.Body.String())
			}
			//! The model is what the client sent, thinking suffix included.
			assertAllResponseHeaderVars(t, header, "claude-sonnet-4.5-thinking", "only", keyID)
		})
	}
}

func TestResponseHeadersOnErrorResponses(t *testing.T) {
	t.Run("invalid json", func(t *testing.T) {
		h := newHeaderTestHandler(t, textUpstream(t))
		setTestResponseHeaders(t, allResponseHeaderVars...)
		for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1/messages/count_tokens"} {
			rec := serveClient(h, http.MethodPost, path, "", "{not json")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s: status=%d", path, rec.Code)
			}
			assertAllResponseHeaderVars(t, sentHeaders(rec), "", "", "")
		}
	})

	t.Run("bad api key", func(t *testing.T) {
		h := newHeaderTestHandler(t, textUpstream(t))
		requireTestAPIKey(t)
		setTestResponseHeaders(t, allResponseHeaderVars...)
		for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/models"} {
			rec := serveClient(h, http.MethodPost, path, "sk-wrong", clientTestBody(t, "claude-sonnet-4.5", false))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s: status=%d", path, rec.Code)
			}
			assertAllResponseHeaderVars(t, sentHeaders(rec), "", "", "")
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		h := newHeaderTestHandler(t, textUpstream(t))
		setTestResponseHeaders(t, allResponseHeaderVars...)
		rec := serveClient(h, http.MethodGet, "/v1/messages", "", "")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status=%d", rec.Code)
		}
		assertAllResponseHeaderVars(t, sentHeaders(rec), "", "", "")
	})

	t.Run("shape error after parse", func(t *testing.T) {
		h := newHeaderTestHandler(t, textUpstream(t))
		setTestResponseHeaders(t, allResponseHeaderVars...)
		rec := serveClient(h, http.MethodPost, "/v1/chat/completions", "", `{"model":"claude-sonnet-4.5","messages":[]}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		assertAllResponseHeaderVars(t, sentHeaders(rec), "claude-sonnet-4.5", "", "")
	})

	for _, stream := range []bool{false, true} {
		name := map[bool]string{false: "upstream error json", true: "upstream error sse"}[stream]
		t.Run(name, func(t *testing.T) {
			h := newHeaderTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "Improperly formed request", http.StatusBadRequest)
			})
			setTestResponseHeaders(t, allResponseHeaderVars...)
			for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
				h.pool.RecordSuccess("only")
				rec := serveClient(h, http.MethodPost, path, "", clientTestBody(t, "claude-sonnet-4.5", stream))
				if rec.Code < 400 {
					t.Fatalf("%s: status=%d body=%s", path, rec.Code, rec.Body.String())
				}
				assertAllResponseHeaderVars(t, sentHeaders(rec), "claude-sonnet-4.5", "only", "")
			}
		})
	}

	t.Run("upstream 500 after retries", func(t *testing.T) {
		h := newHeaderTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "internal error", http.StatusInternalServerError)
		})
		setTestResponseHeaders(t, allResponseHeaderVars...)
		rec := serveClient(h, http.MethodPost, "/v1/messages", "", clientTestBody(t, "claude-sonnet-4.5", false))
		if rec.Code < 500 {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		assertAllResponseHeaderVars(t, sentHeaders(rec), "claude-sonnet-4.5", "only", "")
	})
}

func TestResponseHeadersOnModelsAndCountTokens(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	key, keyID := requireTestAPIKey(t)
	setTestResponseHeaders(t, allResponseHeaderVars...)

	rec := serveClient(h, http.MethodGet, "/v1/models", key, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("models: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertAllResponseHeaderVars(t, sentHeaders(rec), "", "", keyID)

	rec = serveClient(h, http.MethodPost, "/v1/messages/count_tokens", key, clientTestBody(t, "claude-haiku-4.5", false))
	if rec.Code != http.StatusOK {
		t.Fatalf("count_tokens: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertAllResponseHeaderVars(t, sentHeaders(rec), "claude-haiku-4.5", "", keyID)
}

func TestResponseHeadersKeepProxyHeadersAndSkipEmpty(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	setTestResponseHeaders(t,
		config.ResponseHeaderRule{Name: "Cache-Control", Value: "max-age=60", Enabled: true},
		config.ResponseHeaderRule{Name: "X-Account", Value: "{account_id}", Enabled: true},
		config.ResponseHeaderRule{Name: "X-Off", Value: "off", Enabled: false},
		config.ResponseHeaderRule{Name: "X-Static", Value: "on", Enabled: true},
	)

	rec := serveClient(h, http.MethodPost, "/v1/chat/completions", "", clientTestBody(t, "claude-sonnet-4.5", true))
	header := sentHeaders(rec)
	if got := header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("the stream's own Cache-Control must win, got %q", got)
	}
	if header.Get("X-Account") != "only" || header.Get("X-Static") != "on" || len(header.Values("X-Off")) > 0 {
		t.Fatalf("unexpected custom headers: %#v body=%s", header, rec.Body.String())
	}

	rec = serveClient(h, http.MethodGet, "/v1/models", "", "")
	header = sentHeaders(rec)
	if got := header.Get("Cache-Control"); got != "max-age=60" {
		t.Fatalf("a header the proxy does not set must be added, got %q", got)
	}
	if len(header.Values("X-Account")) > 0 {
		t.Fatalf("an empty account must leave the header out, got %q", header.Get("X-Account"))
	}
}

func TestResponseHeadersNotOnAdminOrHealth(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	config.SetPassword("admin-password")
	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Static", Value: "on", Enabled: true})

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/health"},
		{http.MethodGet, "/admin/api/status"},
		{http.MethodOptions, "/v1/messages"},
		{http.MethodPost, "/api/event_logging/batch"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("X-Admin-Password", "admin-password")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := sentHeaders(rec).Get("X-Static"); got != "" {
			t.Errorf("%s %s: X-Static = %q, want none", tc.method, tc.path, got)
		}
	}
}

func TestResponseHeadersExposedForCORS(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	setTestResponseHeaders(t,
		config.ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: true},
		config.ResponseHeaderRule{Name: "X-Kiro-Trace", Value: "{request_id}", Enabled: true},
		config.ResponseHeaderRule{Name: "X-Empty", Value: "{account_id}", Enabled: true},
	)
	header := sentHeaders(serveClient(h, http.MethodGet, "/v1/models", "", ""))
	exposed := header.Get("Access-Control-Expose-Headers")
	if !strings.Contains(exposed, ", x-kiro-trace") || strings.Count(strings.ToLower(exposed), "x-request-id") != 1 {
		t.Fatalf("custom headers must be exposed once each, got %q", exposed)
	}
	if strings.Contains(exposed, "x-empty") {
		t.Fatalf("a header that was left out must not be exposed, got %q", exposed)
	}
	if header.Get("X-Kiro-Trace") != header.Get("X-Request-Id") {
		t.Fatalf("one request has one id: %q vs %q", header.Get("X-Kiro-Trace"), header.Get("X-Request-Id"))
	}
}

func TestResponseHeadersApplyLive(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	first := sentHeaders(serveClient(h, http.MethodGet, "/v1/models", "", ""))
	if len(first.Values("X-Request-Id")) > 0 {
		t.Fatalf("no header may be added by default: %#v", first)
	}

	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: true})
	a := sentHeaders(serveClient(h, http.MethodGet, "/v1/models", "", "")).Get("X-Request-Id")
	b := sentHeaders(serveClient(h, http.MethodGet, "/v1/models", "", "")).Get("X-Request-Id")
	if !requestIDPattern.MatchString(a) || !requestIDPattern.MatchString(b) || a == b {
		t.Fatalf("each request needs its own id, got %q and %q", a, b)
	}

	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: false})
	if got := sentHeaders(serveClient(h, http.MethodGet, "/v1/models", "", "")).Get("X-Request-Id"); got != "" {
		t.Fatalf("a disabled header must stop at once, got %q", got)
	}
}

func TestHeaderInjectingWriterCommitPoints(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Account", Value: "{account_id}", Enabled: true})
	account := &config.Account{ID: "late"}

	t.Run("handler wrote nothing", func(t *testing.T) {
		rec := httptest.NewRecorder()
		_, r, finish := wrapClientResponse(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
		noteResponseAccount(r.Context(), account)
		finish()
		if got := rec.Header().Get("X-Account"); got != "late" {
			t.Fatalf("finish must add the headers to an empty response, got %q", got)
		}
	})

	t.Run("flush commits", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w, r, finish := wrapClientResponse(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
		w.(http.Flusher).Flush()
		noteResponseAccount(r.Context(), account)
		_, _ = w.Write([]byte("x"))
		finish()
		if got := sentHeaders(rec).Get("X-Account"); got != "" {
			t.Fatalf("the account noted after the first flush must not be sent, got %q", got)
		}
	})

	t.Run("late notes resolve at the first write", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w, r, finish := wrapClientResponse(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
		defer finish()
		noteResponseAccount(r.Context(), &config.Account{ID: "first"})
		noteResponseAccount(r.Context(), account)
		w.WriteHeader(http.StatusAccepted)
		if got := sentHeaders(rec).Get("X-Account"); got != "late" {
			t.Fatalf("the last account noted before the response wins, got %q", got)
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Fatalf("the controller must reach the inner writer: %v", err)
		}
	})

	t.Run("notes outside a client request are no-ops", func(t *testing.T) {
		ctx := context.Background()
		noteResponseAccount(ctx, account)
		noteResponseModel(ctx, "m")
		noteResponseKeyID(ctx, "k")
		if requestIDFromContext(ctx) != "" {
			t.Fatal("no request id outside a client request")
		}
	})
}

func TestAdminResponseHeadersRoundTrip(t *testing.T) {
	h := newRegionTestAdmin(t)
	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/response-headers", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("get: status=%d", rec.Code)
	}
	var got struct {
		Headers   []config.ResponseHeaderRule `json:"headers"`
		Variables []string                    `json:"variables"`
		Max       int                         `json:"max"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Headers == nil || len(got.Headers) != 0 || got.Max != config.MaxResponseHeaders || strings.Join(got.Variables, ",") != "request_id,model,account_id,key_id,client_ip" {
		t.Fatalf("unexpected defaults: %s", rec.Body.String())
	}

	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/response-headers",
		`{"headers":[{"name":" X-Request-Id ","value":"{request_id}","enabled":true},{"name":"X-Off","value":"x","enabled":false}]}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("save: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = serveRegionTestAdmin(h, http.MethodGet, "/admin/api/response-headers", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []config.ResponseHeaderRule{{Name: "X-Request-Id", Value: "{request_id}", Enabled: true}, {Name: "X-Off", Value: "x"}}
	if len(got.Headers) != 2 || got.Headers[0] != want[0] || got.Headers[1] != want[1] {
		t.Fatalf("expected the trimmed list back, got %#v", got.Headers)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/api/response-headers", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the endpoint must need admin auth, got %d", rec.Code)
	}
}

func TestAdminResponseHeadersRejectsWithCodeAndIndex(t *testing.T) {
	h := newRegionTestAdmin(t)
	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Keep", Value: "1", Enabled: true})

	for _, tc := range []struct {
		body, code string
		index      float64
		field      string
		value      interface{}
	}{
		{`{"headers":[{"name":"X-Ok","value":"1"},{"name":"X-A","value":"a\r\nX-Evil: 1"}]}`, "response_header_value_invalid", 1, "name", "X-A"},
		{`{"headers":[{"name":"Connection","value":"close"}]}`, "response_header_name_forbidden", 0, "name", "Connection"},
		{`{"headers":[{"name":"X-A","value":"{reqid}"}]}`, "response_header_unknown_variable", 0, "variable", "reqid"},
	} {
		rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/response-headers", tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		body := decodeAdminError(t, rec)
		if body["code"] != tc.code || body["index"] != tc.index || body[tc.field] != tc.value || body["error"] == "" {
			t.Fatalf("unexpected error body: %#v", body)
		}
	}

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/response-headers", `{"headers":`)
	if body := decodeAdminError(t, rec); rec.Code != http.StatusBadRequest || body["code"] != codeInvalidJSON {
		t.Fatalf("invalid JSON: status=%d body=%#v", rec.Code, body)
	}
	if got := config.GetResponseHeaders(); len(got) != 1 || got[0].Name != "X-Keep" {
		t.Fatalf("a rejected save must keep the list, got %#v", got)
	}
}

func TestRequestLogCarriesRequestID(t *testing.T) {
	h := newHeaderTestHandler(t, textUpstream(t))
	s := getObserveStore()
	setTestResponseHeaders(t, config.ResponseHeaderRule{Name: "X-Request-Id", Value: "{request_id}", Enabled: true})

	ids := make([]string, 0, 2)
	for _, body := range []string{clientTestBody(t, "claude-sonnet-4.5", false), "{not json"} {
		rec := serveClient(h, http.MethodPost, "/v1/chat/completions", "", body)
		id := sentHeaders(rec).Get("X-Request-Id")
		if !requestIDPattern.MatchString(id) {
			t.Fatalf("status=%d X-Request-Id=%q", rec.Code, id)
		}
		got := s.RecentRequests(1)
		if len(got) != 1 || got[0].RequestID != id {
			t.Fatalf("the log row must carry the id the client got (%s), got %#v", id, got)
		}
		ids = append(ids, id)
	}

	for _, id := range ids {
		page := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: id})
		if !page.Persistent || page.Total != 1 || page.Requests[0].RequestID != id {
			t.Fatalf("search for %s: persistent=%v total=%d rows=%#v", id, page.Persistent, page.Total, page.Requests)
		}
	}
	recent, err := loadRecentRequestsFromDB(10)
	if err != nil || len(recent) < 2 || recent[0].RequestID != ids[1] || recent[1].RequestID != ids[0] {
		t.Fatalf("reloaded rows must keep their ids: err=%v rows=%#v", err, recent)
	}
}

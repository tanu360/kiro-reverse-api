package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
)

const countTokensTestBody = `{"model":"claude-sonnet-4-5-thinking","system":"Be brief <b>","messages":[{"role":"user","content":"count me & my tools"}],"tools":[{"name":"read","input_schema":{"type":"object"}}]}`

// countTokensSeen is what the fake external service received.
type countTokensSeen struct {
	path   string
	header http.Header
	body   string
}

func setupCountTokensTest(t *testing.T) *Handler {
	t.Helper()
	if err := config.Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	return &Handler{}
}

// fakeCountTokensService answers every POST with status and body, recording what it got.
func fakeCountTokensService(t *testing.T, status int, answer string) (*httptest.Server, chan countTokensSeen) {
	t.Helper()
	seen := make(chan countTokensSeen, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen <- countTokensSeen{path: r.URL.Path, header: r.Header.Clone(), body: string(body)}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func setCountTokensService(t *testing.T, url, authType, key string) {
	t.Helper()
	var keyPtr *string
	if key != "" {
		keyPtr = &key
	}
	if err := config.UpdateCountTokensSettings(url, authType, keyPtr, key == ""); err != nil {
		t.Fatalf("save count tokens settings: %v", err)
	}
}

func postCountTokens(t *testing.T, h *Handler, path string, headers map[string]string) (int, int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(countTokensTestBody))
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST %s: status = %d body=%s", path, rec.Code, rec.Body.String())
	}
	var answer map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatalf("POST %s: decode %q: %v", path, rec.Body.String(), err)
	}
	return rec.Code, answer["input_tokens"]
}

// localCountTokensEstimate is what count_tokens answers with no external service set.
func localCountTokensEstimate(t *testing.T, h *Handler) int {
	t.Helper()
	saved := config.GetCountTokensSettings()
	setCountTokensService(t, "", "", "")
	_, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil)
	if saved.APIURL != "" {
		setCountTokensService(t, saved.APIURL, saved.AuthType, saved.APIKey)
	}
	if n < 1 {
		t.Fatalf("local estimate = %d", n)
	}
	return n
}

func TestCountTokensForwardsToExternalAPI(t *testing.T) {
	h := setupCountTokensTest(t)
	server, seen := fakeCountTokensService(t, http.StatusOK, `{"input_tokens":4242}`)
	setCountTokensService(t, server.URL+"/v1/messages/count_tokens", config.CountTokensAuthXAPIKey, "sk-ext-0123456789")
	local := localCountTokensEstimate(t, h)
	if local == 4242 {
		t.Fatalf("the local estimate must differ from the fake's answer")
	}

	for _, path := range []string{"/v1/messages/count_tokens", "/cc/v1/messages/count_tokens", "/messages/count_tokens"} {
		_, n := postCountTokens(t, h, path, map[string]string{
			"anthropic-version": "2023-06-01",
			"anthropic-beta":    "token-counting-2024-11-01",
		})
		if n != 4242 {
			t.Fatalf("%s answered %d, want the external 4242", path, n)
		}
		got := <-seen
		if got.path != "/v1/messages/count_tokens" {
			t.Fatalf("%s: forwarded to %q", path, got.path)
		}
		if got.header.Get("anthropic-version") != "2023-06-01" || got.header.Get("anthropic-beta") != "token-counting-2024-11-01" {
			t.Fatalf("%s: anthropic headers = %v", path, got.header)
		}
		if got.header.Get("Content-Type") != "application/json" || got.header.Get(countTokensHopHeader) != countTokensHopID {
			t.Fatalf("%s: content type or hop header missing: %v", path, got.header)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal([]byte(got.body), &body); err != nil {
			t.Fatalf("%s: forwarded body %q: %v", path, got.body, err)
		}
		// The thinking suffix goes; the client's model ID is not mapped to a Kiro ID.
		if string(body["model"]) != `"claude-sonnet-4-5"` {
			t.Fatalf("%s: forwarded model = %s", path, body["model"])
		}
		if string(body["system"]) != `"Be brief <b>"` ||
			string(body["messages"]) != `[{"role":"user","content":"count me & my tools"}]` ||
			string(body["tools"]) != `[{"name":"read","input_schema":{"type":"object"}}]` {
			t.Fatalf("%s: forwarded body changed: %s", path, got.body)
		}
	}

	// No anthropic-version from the client: the service still gets one.
	postCountTokens(t, h, "/v1/messages/count_tokens", nil)
	if got := <-seen; got.header.Get("anthropic-version") != defaultAnthropicVersion || got.header.Get("anthropic-beta") != "" {
		t.Fatalf("default headers = %v", got.header)
	}
}

func TestCountTokensExternalAuthHeaderModes(t *testing.T) {
	h := setupCountTokensTest(t)
	server, seen := fakeCountTokensService(t, http.StatusOK, `{"input_tokens":7}`)
	clientHeaders := map[string]string{"x-api-key": "client-proxy-key", "Authorization": "Bearer client-proxy-key"}

	for _, tc := range []struct {
		name, authType, key, wantXAPIKey, wantAuthorization string
	}{
		{"x-api-key", config.CountTokensAuthXAPIKey, "sk-ext-key-1", "sk-ext-key-1", ""},
		{"bearer", config.CountTokensAuthBearer, "sk-ext-key-2", "", "Bearer sk-ext-key-2"},
		{"no key", config.CountTokensAuthBearer, "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setCountTokensService(t, server.URL, tc.authType, tc.key)
			if _, n := postCountTokens(t, h, "/cc/v1/messages/count_tokens", clientHeaders); n != 7 {
				t.Fatalf("answer = %d, want 7", n)
			}
			got := <-seen
			if x := got.header.Get("x-api-key"); x != tc.wantXAPIKey {
				t.Fatalf("x-api-key = %q, want %q", x, tc.wantXAPIKey)
			}
			if a := got.header.Get("Authorization"); a != tc.wantAuthorization {
				t.Fatalf("Authorization = %q, want %q", a, tc.wantAuthorization)
			}
			for name, values := range got.header {
				for _, value := range values {
					if strings.Contains(value, "client-proxy-key") {
						t.Fatalf("the client's own key was forwarded in %s", name)
					}
				}
			}
		})
	}
}

func TestCountTokensFallsBackOnNon2xx(t *testing.T) {
	h := setupCountTokensTest(t)
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		_, _ = io.WriteString(w, `{"input_tokens":9999}`)
	}))
	t.Cleanup(target.Close)
	local := localCountTokensEstimate(t, h)

	for _, tc := range []struct {
		name   string
		status int
		answer string
		header map[string]string
	}{
		{"server error", http.StatusInternalServerError, `{"type":"error"}`, nil},
		{"unauthorized", http.StatusUnauthorized, `{"input_tokens":1234}`, nil},
		{"not found", http.StatusNotFound, `not found`, nil},
		{"redirect", http.StatusFound, ``, map[string]string{"Location": target.URL}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for name, value := range tc.header {
					w.Header().Set(name, value)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.answer)
			}))
			t.Cleanup(server.Close)
			setCountTokensService(t, server.URL, config.CountTokensAuthXAPIKey, "sk-ext-0123456789")
			if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil); n != local {
				t.Fatalf("answer = %d, want the local estimate %d", n, local)
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatalf("a redirect was followed %d times; the key must not go to another host", redirected.Load())
	}
}

func TestCountTokensFallsBackOnTimeout(t *testing.T) {
	h := setupCountTokensTest(t)
	old := countTokensRemoteTimeout
	countTokensRemoteTimeout = 100 * time.Millisecond
	t.Cleanup(func() { countTokensRemoteTimeout = old })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reading the body lets the server notice the client hanging up.
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
		_, _ = io.WriteString(w, `{"input_tokens":4242}`)
	}))
	t.Cleanup(server.Close)
	local := localCountTokensEstimate(t, h)
	setCountTokensService(t, server.URL, config.CountTokensAuthXAPIKey, "")

	start := time.Now()
	_, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("count_tokens took %v; the timeout must cut the call short", elapsed)
	}
	if n != local {
		t.Fatalf("answer = %d, want the local estimate %d", n, local)
	}
}

func TestCountTokensFallsBackOnBadAnswer(t *testing.T) {
	h := setupCountTokensTest(t)
	local := localCountTokensEstimate(t, h)

	for name, answer := range map[string]string{
		"not json":     `<html>ok</html>`,
		"empty object": `{}`,
		"null count":   `{"input_tokens":null}`,
		"negative":     `{"input_tokens":-3}`,
		"fraction":     `{"input_tokens":12.5}`,
		"string":       `{"input_tokens":"12"}`,
		"too large":    `{"input_tokens":12,"pad":"` + strings.Repeat("x", countTokensMaxAnswerBytes) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			server, _ := fakeCountTokensService(t, http.StatusOK, answer)
			setCountTokensService(t, server.URL, config.CountTokensAuthXAPIKey, "")
			if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil); n != local {
				t.Fatalf("answer = %d, want the local estimate %d", n, local)
			}
		})
	}

	t.Run("connection refused", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		url := server.URL
		server.Close()
		setCountTokensService(t, url, config.CountTokensAuthXAPIKey, "")
		if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil); n != local {
			t.Fatalf("answer = %d, want the local estimate %d", n, local)
		}
	})

	t.Run("zero reads as one", func(t *testing.T) {
		server, _ := fakeCountTokensService(t, http.StatusOK, `{"input_tokens":0}`)
		setCountTokensService(t, server.URL, config.CountTokensAuthXAPIKey, "")
		if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil); n != 1 {
			t.Fatalf("answer = %d, want 1", n)
		}
	})
}

func TestCountTokensHopHeaderSkipsExternal(t *testing.T) {
	h := setupCountTokensTest(t)
	local := localCountTokensEstimate(t, h)
	server, seen := fakeCountTokensService(t, http.StatusOK, `{"input_tokens":4242}`)
	setCountTokensService(t, server.URL, config.CountTokensAuthXAPIKey, "")

	// A request that already passed through this process, or through too many proxies, is
	// answered locally.
	tooMany := strings.TrimSuffix(strings.Repeat("proxy-x,", countTokensMaxHops), ",")
	for _, hops := range []string{countTokensHopID, "proxy-a, " + countTokensHopID, tooMany} {
		if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", map[string]string{countTokensHopHeader: hops}); n != local {
			t.Fatalf("answer with hops %q = %d, want the local estimate %d", hops, n, local)
		}
	}
	if len(seen) != 0 {
		t.Fatalf("a request that came back reached the external service")
	}

	// A request from another proxy still goes to this proxy's own service, with this process
	// added to the list; entries that cannot be a process ID are not passed on.
	if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", map[string]string{countTokensHopHeader: "proxy-a, bad id ,1"}); n != 4242 {
		t.Fatalf("answer from a proxy chain = %d, want the external 4242", n)
	}
	if got := (<-seen).header.Get(countTokensHopHeader); got != "proxy-a,1,"+countTokensHopID {
		t.Fatalf("forwarded hops = %q", got)
	}

	// A URL pointing back at this proxy: one hop, answered there with the local estimate (of
	// the forwarded body, whose model has lost the thinking suffix).
	var calls atomic.Int32
	self := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(self.Close)
	setCountTokensService(t, self.URL+"/v1/messages/count_tokens", config.CountTokensAuthXAPIKey, "")
	if _, n := postCountTokens(t, h, "/v1/messages/count_tokens", nil); n < 1 || n == 4242 {
		t.Fatalf("self-loop answer = %d, want a local estimate", n)
	}
	if calls.Load() != 1 {
		t.Fatalf("the proxy called itself %d times, want 1", calls.Load())
	}
}

func TestCountTokensAdminAPIMasksKey(t *testing.T) {
	h := newAdminAuthTestHandler(t, "admin-password")
	token, _, err := h.adminSessions.Issue()
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, body string) (int, map[string]interface{}, string) {
		t.Helper()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, "/admin/api/count-tokens", reader)
		req.Header.Set("X-Admin-Token", token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out, rec.Body.String()
	}

	// Unauthenticated: refused.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/api/count-tokens", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET without a session = %d, want 401", rec.Code)
	}

	code, got, _ := call(http.MethodGet, "")
	if code != http.StatusOK || got["countTokensApiUrl"] != "" || got["countTokensAuthType"] != "x-api-key" ||
		got["countTokensApiKeySet"] != false || got["countTokensApiKeyMasked"] != "" {
		t.Fatalf("defaults: %d %v", code, got)
	}

	const key = "sk-ant-api03-secretvalue-WXYZ"
	code, got, raw := call(http.MethodPost, `{"countTokensApiUrl":" https://count.example/v1/messages/count_tokens ","countTokensAuthType":"Bearer","countTokensApiKey":"`+key+`"}`)
	if code != http.StatusOK || got["success"] != true {
		t.Fatalf("save: %d %s", code, raw)
	}
	code, got, raw = call(http.MethodGet, "")
	if strings.Contains(raw, "secretvalue") {
		t.Fatalf("GET leaks the key: %s", raw)
	}
	if code != http.StatusOK || got["countTokensApiUrl"] != "https://count.example/v1/messages/count_tokens" ||
		got["countTokensAuthType"] != "bearer" || got["countTokensApiKeySet"] != true || got["countTokensApiKeyMasked"] != "••••WXYZ" {
		t.Fatalf("after save: %d %v", code, got)
	}

	// An edit with a blank key keeps it on the same host and drops it on another host.
	if code, _, raw := call(http.MethodPost, `{"countTokensApiUrl":"https://count.example/v2/count_tokens","countTokensAuthType":"x-api-key","countTokensApiKey":""}`); code != http.StatusOK {
		t.Fatalf("edit: %d %s", code, raw)
	}
	if s := config.GetCountTokensSettings(); s.APIKey != key || s.AuthType != config.CountTokensAuthXAPIKey {
		t.Fatalf("after a blank-key edit: %+v", s)
	}
	if code, _, raw := call(http.MethodPost, `{"countTokensApiUrl":"http://127.0.0.1:9000/count","countTokensApiKey":""}`); code != http.StatusOK {
		t.Fatalf("move: %d %s", code, raw)
	}
	if _, got, raw := call(http.MethodGet, ""); got["countTokensApiKeySet"] != false || got["countTokensApiUrl"] != "http://127.0.0.1:9000/count" {
		t.Fatalf("after a move to another host: %s", raw)
	}

	// A short key masks to dots only.
	if code, _, raw := call(http.MethodPost, `{"countTokensApiKey":"short-key"}`); code != http.StatusOK {
		t.Fatalf("key only: %d %s", code, raw)
	}
	if _, got, raw := call(http.MethodGet, ""); got["countTokensApiKeyMasked"] != "••••" || got["countTokensApiUrl"] != "http://127.0.0.1:9000/count" || strings.Contains(raw, "short-key") {
		t.Fatalf("short key: %s", raw)
	}

	for _, tc := range []struct{ body, code string }{
		{`{not json`, codeInvalidJSON},
		{`{"countTokensApiUrl":"ftp://count.example"}`, codeCountTokensURL},
		{`{"countTokensApiUrl":"https://user:pw@count.example"}`, codeCountTokensURL},
		{`{"countTokensApiUrl":"https://count.example","countTokensAuthType":"basic"}`, codeCountTokensAuthType},
		{`{"countTokensApiUrl":"https://count.example","countTokensApiKey":"has space"}`, codeCountTokensKey},
	} {
		code, got, raw := call(http.MethodPost, tc.body)
		if code != http.StatusBadRequest || got["code"] != tc.code {
			t.Fatalf("POST %s = %d %s, want 400 %s", tc.body, code, raw, tc.code)
		}
	}
	if s := config.GetCountTokensSettings(); s.APIURL != "http://127.0.0.1:9000/count" || s.APIKey != "short-key" {
		t.Fatalf("a refused update changed the settings: %+v", s)
	}

	// clearApiKey drops the key and keeps the URL.
	if code, _, raw := call(http.MethodPost, `{"countTokensApiUrl":"http://127.0.0.1:9000/count","clearApiKey":true}`); code != http.StatusOK {
		t.Fatalf("clear key: %d %s", code, raw)
	}
	if _, got, _ := call(http.MethodGet, ""); got["countTokensApiKeySet"] != false || got["countTokensApiUrl"] != "http://127.0.0.1:9000/count" {
		t.Fatalf("after clear: %v", got)
	}

	// An empty URL turns it off and drops everything.
	key2 := "sk-another-0123456789"
	setCountTokensService(t, "http://127.0.0.1:9000/count", config.CountTokensAuthBearer, key2)
	if code, _, raw := call(http.MethodPost, `{"countTokensApiUrl":""}`); code != http.StatusOK {
		t.Fatalf("remove: %d %s", code, raw)
	}
	if s := config.GetCountTokensSettings(); s != (config.CountTokensSettings{AuthType: config.CountTokensAuthXAPIKey}) {
		t.Fatalf("after remove: %+v", s)
	}
}

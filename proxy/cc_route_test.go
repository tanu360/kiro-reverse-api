package proxy

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"kiro-proxy/config"
)

// /cc is the base URL Claude Code is pointed at (ANTHROPIC_BASE_URL=http://host/cc). It is an
// alias of /v1 on the same handlers: the stream already starts at once, message_start carries
// the estimated input tokens and the last message_delta the final usage.

const ccTestRequest = `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]%s}`

func sseEventTypes(t *testing.T, body string) []string {
	t.Helper()
	var events []string
	scanner := bufio.NewScanner(strings.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		if name, ok := strings.CutPrefix(scanner.Text(), "event: "); ok {
			events = append(events, name)
		}
	}
	return events
}

func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func TestCCMessagesRoutesLikeV1(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeKiroTextResponse(t, w, "Hi there")
	})

	post := func(path, extra string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(strings.Replace(ccTestRequest, "%s", extra, 1))))
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s%s: status = %d body=%s", path, extra, rec.Code, rec.Body.String())
		}
		return rec
	}

	v1Stream := post("/v1/messages", `,"stream":true`)
	ccStream := post("/cc/v1/messages", `,"stream":true`)
	if ct := ccStream.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("/cc stream content type = %q", ct)
	}
	v1Events, ccEvents := sseEventTypes(t, v1Stream.Body.String()), sseEventTypes(t, ccStream.Body.String())
	if len(ccEvents) == 0 || !reflect.DeepEqual(v1Events, ccEvents) {
		t.Fatalf("/cc events = %v, want the /v1 sequence %v", ccEvents, v1Events)
	}
	if ccEvents[0] != "message_start" || ccEvents[len(ccEvents)-1] != "message_stop" {
		t.Fatalf("/cc events = %v, want message_start first and message_stop last", ccEvents)
	}
	if !strings.Contains(ccStream.Body.String(), `"text":"Hi there"`) {
		t.Fatalf("/cc stream lost the text: %s", ccStream.Body.String())
	}

	var v1Msg, ccMsg map[string]interface{}
	if err := json.Unmarshal(post("/v1/messages", "").Body.Bytes(), &v1Msg); err != nil {
		t.Fatalf("decode /v1: %v", err)
	}
	if err := json.Unmarshal(post("/cc/v1/messages", "").Body.Bytes(), &ccMsg); err != nil {
		t.Fatalf("decode /cc: %v", err)
	}
	if !reflect.DeepEqual(sortedKeys(v1Msg), sortedKeys(ccMsg)) || ccMsg["type"] != "message" ||
		!reflect.DeepEqual(v1Msg["content"], ccMsg["content"]) || ccMsg["stop_reason"] != v1Msg["stop_reason"] {
		t.Fatalf("/cc message = %v, want the /v1 shape %v", ccMsg, v1Msg)
	}

	// The Requests page logs /cc like /v1.
	if got := requestEndpointForPath("/cc/v1/messages"); got != requestEndpointClaude {
		t.Fatalf("/cc/v1/messages is traced as %q", got)
	}
}

func TestCCRoutesRequireSameAuth(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	if _, err := config.AddApiKey(config.ApiKeyEntry{Name: "cc", Key: "sk-cc-client", Enabled: true}); err != nil {
		t.Fatalf("add key: %v", err)
	}
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}
	h := &Handler{}

	for _, path := range []string{"/v1/messages", "/cc/v1/messages", "/v1/messages/count_tokens", "/cc/v1/messages/count_tokens"} {
		for name, key := range map[string]string{"missing": "", "wrong": "sk-wrong"} {
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
			if key != "" {
				req.Header.Set("x-api-key", key)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			var body struct {
				Type  string `json:"type"`
				Error struct {
					Type string `json:"type"`
				} `json:"error"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if rec.Code != http.StatusUnauthorized || body.Type != "error" || body.Error.Type != "authentication_error" {
				t.Fatalf("%s with a %s key = %d %s, want the Claude 401 error", path, name, rec.Code, rec.Body.String())
			}
		}
	}

	// The right key passes auth on count_tokens; Claude Code sends it as Authorization: Bearer.
	req := httptest.NewRequest(http.MethodPost, "/cc/v1/messages/count_tokens", strings.NewReader(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer sk-cc-client")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"input_tokens"`) {
		t.Fatalf("count_tokens with a valid key = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCCUnknownPathIs404(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}
	for _, path := range []string{"/cc/v1/models", "/cc/v1/chat/completions", "/cc/anything", "/cc/v1/messages/batches"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Accept", "text/html")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "<html") {
			t.Fatalf("GET %s = %d %q, want a plain 404", path, rec.Code, rec.Body.String())
		}
	}

	// Claude Code's telemetry batch gets the same JSON answer as without the prefix.
	for _, path := range []string{"/api/event_logging/batch", "/cc/api/event_logging/batch"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"events":[]}`)))
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
			t.Fatalf("POST %s = %d %q", path, rec.Code, rec.Body.String())
		}
	}
}

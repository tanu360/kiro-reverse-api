package proxy

import (
	"encoding/json"
	"net/http"
	"testing"

	"kiro-proxy/config"
)

// A wrong method on a real /v1 path answers a JSON 405 in that path's API shape, with Allow
// and X-Should-Retry: false, not net/http's plain-text "Method Not Allowed".
func TestWrongMethodOnClientPathIsJSON405(t *testing.T) {
	h := modelTestHandler(t)
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-wrong-method"})
	requireKeys(t)

	cases := []struct {
		method, path string
		anthropic    bool
		allow, text  string
	}{
		{http.MethodGet, "/v1/messages", true, "POST", "GET is not allowed on /v1/messages. Use POST."},
		{http.MethodGet, "/v1/messages/count_tokens", true, "POST", "GET is not allowed on /v1/messages/count_tokens. Use POST."},
		{http.MethodGet, "/v1/chat/completions", false, "POST", "GET is not allowed on /v1/chat/completions. Use POST."},
		{http.MethodGet, "/v1/responses", false, "POST", "GET is not allowed on /v1/responses. Use POST."},
		{http.MethodPost, "/v1/responses/resp_123", false, "GET, HEAD, DELETE", "POST is not allowed on /v1/responses/resp_123. Use GET or DELETE."},
		{http.MethodPost, "/v1/models", false, "GET, HEAD", "POST is not allowed on /v1/models. Use GET."},
		{http.MethodPost, "/v1/models", true, "GET, HEAD", "POST is not allowed on /v1/models. Use GET."},
		{http.MethodDelete, "/v1/models/claude-haiku-4.5", false, "GET, HEAD", "DELETE is not allowed on /v1/models/claude-haiku-4.5. Use GET."},
		{http.MethodPost, "/v1/codex/models", false, "GET, HEAD", "POST is not allowed on /v1/codex/models. Use GET."},
	}
	for _, c := range cases {
		rec := serveModels(h, c.method, c.path, key.Key, c.anthropic)
		name := c.method + " " + c.path
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: status %d, want 405; body %s", name, rec.Code, rec.Body.String())
			continue
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("%s: Content-Type %q, want JSON", name, ct)
		}
		if got := rec.Header().Get("Allow"); got != c.allow {
			t.Errorf("%s: Allow %q, want %q", name, got, c.allow)
		}
		if got := rec.Header().Get(shouldRetryHeader); got != "false" {
			t.Errorf("%s: X-Should-Retry %q, want false", name, got)
		}
		var body struct {
			Type  string                 `json:"type"`
			Error map[string]interface{} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: body is not JSON: %q", name, rec.Body.String())
			continue
		}
		if body.Error["type"] != "invalid_request_error" || body.Error["message"] != c.text {
			t.Errorf("%s: error = %v, want invalid_request_error %q", name, body.Error, c.text)
		}
		if c.anthropic {
			if body.Type != "error" {
				t.Errorf("%s: Anthropic body without type error: %s", name, rec.Body.String())
			}
			if _, has := body.Error["code"]; has {
				t.Errorf("%s: Anthropic body carries OpenAI code: %s", name, rec.Body.String())
			}
		} else {
			if _, has := body.Error["code"]; !has {
				t.Errorf("%s: OpenAI body without code: %s", name, rec.Body.String())
			}
			if body.Type != "" {
				t.Errorf("%s: OpenAI body carries Anthropic type: %s", name, rec.Body.String())
			}
		}
	}
}

// HEAD is GET without a body, so a monitor that probes /v1/models with it still gets 200.
func TestHeadOnModelsIsAllowed(t *testing.T) {
	h := modelTestHandler(t)
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-head-models"})
	requireKeys(t)
	if rec := serveModels(h, http.MethodHead, "/v1/models", key.Key, false); rec.Code != http.StatusOK {
		t.Fatalf("HEAD /v1/models = %d, want 200", rec.Code)
	}
}

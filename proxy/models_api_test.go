package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func serveModels(h *Handler, method, path, key string, anthropic bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if anthropic {
		req.Header.Set("anthropic-version", "2023-06-01")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestModelsListHasBothSDKShapes(t *testing.T) {
	h := modelTestHandler(t)
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-shape"})
	requireKeys(t)
	rec := serveModels(h, http.MethodGet, "/v1/models", key.Key, true)
	var body struct {
		Object  string                   `json:"object"`
		Data    []map[string]interface{} `json:"data"`
		HasMore *bool                    `json:"has_more"`
		FirstID string                   `json:"first_id"`
		LastID  string                   `json:"last_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if body.Object != "list" || body.HasMore == nil || *body.HasMore || body.FirstID == "" || body.LastID == "" {
		t.Fatalf("list envelope = %+v", body)
	}
	for _, m := range body.Data {
		if m["type"] != "model" || m["display_name"] == "" || m["created_at"] != "2025-01-01T00:00:00Z" || m["created"] == nil || m["object"] != "model" {
			t.Fatalf("model entry missing a field: %v", m)
		}
	}
	if got := modelDisplayName("claude-haiku-4.5"); got != "Claude Haiku 4.5" {
		t.Fatalf("display name = %q", got)
	}

	rec = serveModels(h, http.MethodGet, "/v1/models?limit=2", key.Key, true)
	var page struct {
		Data    []map[string]interface{} `json:"data"`
		HasMore bool                     `json:"has_more"`
		LastID  string                   `json:"last_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil || len(page.Data) != 2 || !page.HasMore {
		t.Fatalf("limit=2: %s", rec.Body.String())
	}
	rec = serveModels(h, http.MethodGet, "/v1/models?limit=1000&after_id="+page.LastID, key.Key, true)
	var rest struct {
		Data []map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rest); err != nil || len(rest.Data) != len(body.Data)-2 {
		t.Fatalf("after_id page has %d of %d", len(rest.Data), len(body.Data)-2)
	}
	if rec := serveModels(h, http.MethodGet, "/v1/models?limit=0", key.Key, true); rec.Code != http.StatusBadRequest {
		t.Fatalf("limit=0: %d", rec.Code)
	}
}

func TestModelRetrieve(t *testing.T) {
	h := modelTestHandler(t)
	key := addTestKey(t, config.ApiKeyEntry{Key: "sk-models-get"})
	requireKeys(t)
	for _, anthropic := range []bool{false, true} {
		rec := serveModels(h, http.MethodGet, "/v1/models/claude-haiku-4.5", key.Key, anthropic)
		var m map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil || rec.Code != http.StatusOK || m["id"] != "claude-haiku-4.5" || m["type"] != "model" {
			t.Fatalf("retrieve: %d %s", rec.Code, rec.Body.String())
		}
	}
	rec := serveModels(h, http.MethodGet, "/v1/models/no-such-model", key.Key, false)
	if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") ||
		!strings.Contains(rec.Body.String(), `"code":"model_not_found"`) || rec.Header().Get(shouldRetryHeader) != "false" {
		t.Fatalf("unknown model: %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
	rec = serveModels(h, http.MethodGet, "/v1/models/no-such-model", key.Key, true)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"type":"not_found_error"`) {
		t.Fatalf("unknown model, Anthropic shape: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveModels(h, http.MethodGet, "/v1/models/claude-haiku-4.5", "sk-wrong-key-0000", false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong key must not read a model: %d", rec.Code)
	}
}

func TestUnknownClientPathIsJSON404(t *testing.T) {
	h := modelTestHandler(t)
	for _, anthropic := range []bool{false, true} {
		rec := serveModels(h, http.MethodPost, "/v1/embeddings", "", anthropic)
		if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("anthropic=%t: %d %q %s", anthropic, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
		var body map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == nil {
			t.Fatalf("body %s", rec.Body.String())
		}
	}
}

func TestOpenAIErrorBodiesCarryCodeAndParam(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handler{}).sendOpenAIError(rec, http.StatusNotFound, "invalid_request_error", `model "x" is not available on any account`)
	var body struct {
		Error map[string]interface{} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error["code"] != "model_not_found" || body.Error["param"] != "model" {
		t.Fatalf("error = %v", body.Error)
	}
	rec = httptest.NewRecorder()
	(&Handler{}).sendOpenAIError(rec, http.StatusBadRequest, "invalid_request_error", "messages must not be empty")
	if !strings.Contains(rec.Body.String(), `"code":null`) || !strings.Contains(rec.Body.String(), `"param":"messages"`) {
		t.Fatalf("a validation error names its field: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	(&Handler{}).sendOpenAIError(rec, http.StatusServiceUnavailable, "server_error", "No available accounts")
	if !strings.Contains(rec.Body.String(), `"code":null`) || !strings.Contains(rec.Body.String(), `"param":null`) {
		t.Fatalf("errors without a code carry null: %s", rec.Body.String())
	}
}

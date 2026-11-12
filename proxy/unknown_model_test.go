package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A model that no account lists is a client mistake: it must come back as 404
// in each API's own error shape, not as a 503 that tells clients to retry.
func TestUnknownModelReturnsNotFound(t *testing.T) {
	cases := []struct {
		name, path, body, errType string
	}{
		{"messages", "/v1/messages", `{"model":"no-such-model","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, "not_found_error"},
		{"messages stream", "/v1/messages", `{"model":"no-such-model","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, "not_found_error"},
		{"chat", "/v1/chat/completions", `{"model":"no-such-model","messages":[{"role":"user","content":"hi"}]}`, "invalid_request_error"},
		{"chat stream", "/v1/chat/completions", `{"model":"no-such-model","stream":true,"messages":[{"role":"user","content":"hi"}]}`, "invalid_request_error"},
		{"responses", "/v1/responses", `{"model":"no-such-model","input":"hi"}`, "invalid_request_error"},
		{"responses stream", "/v1/responses", `{"model":"no-such-model","stream":true,"input":"hi"}`, "invalid_request_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newResponsesTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("upstream called for a model no account offers")
				w.WriteHeader(http.StatusInternalServerError)
			})
			h.pool.SetModelList("responses-account", []string{"claude-sonnet-4.5"})
			t.Cleanup(func() { h.pool.SetModelList("responses-account", nil) })

			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body)))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
			}
			var payload struct {
				Error struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode body %q: %v", rec.Body.String(), err)
			}
			if payload.Error.Type != tc.errType || !strings.Contains(payload.Error.Message, "no-such-model") {
				t.Fatalf("error = %+v, want type %s naming the model", payload.Error, tc.errType)
			}
		})
	}
}

func TestKnownModelOnBusyPoolStaysUnavailable(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream called with no usable account")
	})
	h.pool.SetModelList("responses-account", []string{"claude-sonnet-4.5"})
	t.Cleanup(func() { h.pool.SetModelList("responses-account", nil) })
	status, errType, _ := h.noAccountError(context.Background(), "claude-sonnet-4.5", "server_error")
	if status != http.StatusServiceUnavailable || errType != "server_error" {
		t.Fatalf("noAccountError(known) = %d %s, want 503 server_error", status, errType)
	}
}

package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"kiro-proxy/config"
)

// An Anthropic client (it sends anthropic-version) gets the Anthropic error shape from
// /v1/models, with the top-level "type":"error"; an OpenAI client keeps its own shape.
func TestModelsErrorShapeFollowsClient(t *testing.T) {
	h := newKeyAccessHandler(t, recordingUpstream(t, &servedBy{}), "free-a")
	addTestKey(t, config.ApiKeyEntry{Key: "sk-models-shape-0123456789"})
	requireKeys(t)

	for _, tc := range []struct {
		name      string
		anthropic bool
		wantType  string
	}{
		{"anthropic", true, "error"},
		{"openai", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
			req.Header.Set("X-Api-Key", "sk-bogus")
			if tc.anthropic {
				req.Header.Set("anthropic-version", "2023-06-01")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			var body struct {
				Type  string `json:"type"`
				Error struct {
					Type string `json:"type"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode %s: %v", rec.Body.String(), err)
			}
			if rec.Code != http.StatusUnauthorized || body.Type != tc.wantType || body.Error.Type != "authentication_error" {
				t.Fatalf("status=%d body=%s, want top-level type %q", rec.Code, rec.Body.String(), tc.wantType)
			}
		})
	}
}

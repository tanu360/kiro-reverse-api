package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Right after a start the models cache is empty until the first listing. The Codex
// list then lists what the accounts serve, as /v1/models does, and not the built-in
// fallback, which names models a free account cannot use.
func TestCodexModelsListsTheAccountsModelsBeforeTheFirstSweep(t *testing.T) {
	h := newResponsesTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("inference endpoint called while listing models")
		w.WriteHeader(http.StatusInternalServerError)
	})
	t.Cleanup(func() { publishNativeModels(nil) })
	t.Cleanup(func() { h.pool.SetModelList("responses-account", nil) })
	stubRestTransport(t, func(r *http.Request) (*http.Response, error) {
		if !strings.Contains(r.URL.Path, "ListAvailableModels") {
			return jsonResponse(http.StatusNotFound, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"models":[{"modelId":"claude-haiku-4.5"},{"modelId":"glm-5"}]}`), nil
	})

	rec := httptest.NewRecorder()
	h.handleCodexModels(rec, httptest.NewRequest(http.MethodGet, "/v1/codex/models", nil))
	var body codexModelsResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var slugs []string
	for _, m := range body.Models {
		slugs = append(slugs, m.Slug)
	}
	if got := strings.Join(slugs, ","); got != "claude-haiku-4.5,glm-5,gpt-5.4-mini" {
		t.Fatalf("codex models = %s, want the listed models and the alias that maps to one", got)
	}
}

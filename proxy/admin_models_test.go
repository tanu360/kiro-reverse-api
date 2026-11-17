package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"kiro-proxy/config"
)

func listAdminModels(t *testing.T, h *Handler) []string {
	t.Helper()
	rec := adminRequest(t, h, http.MethodGet, "/models", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /models = %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body.Models
}

func TestAdminModelsListsCachedModelsThenAuto(t *testing.T) {
	h := modelTestHandler(t)
	config.SetPassword("admin-password")
	h.cachedModels = append(h.cachedModels, ModelInfo{ModelId: "CLAUDE-HAIKU-4.5"})

	got := listAdminModels(t, h)
	want := []string{"claude-haiku-4.5", "claude-opus-4.5", "auto"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %v, want %v", got, want)
	}
}

func TestAdminModelsFallsBackBeforeAnyAccountReported(t *testing.T) {
	h := modelTestHandler(t)
	config.SetPassword("admin-password")
	h.cachedModels = nil

	got := listAdminModels(t, h)
	want := append(append([]string{}, fallbackModelIDs...), "auto")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %v, want %v", got, want)
	}
}

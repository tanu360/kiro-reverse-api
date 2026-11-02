package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"strings"
	"testing"
)

func TestAdminModelMappingsRejectsInvalidSave(t *testing.T) {
	h := newRegionTestAdmin(t)
	before := config.GetModelMappings()

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/model-mappings",
		`{"mappings":[{"key":"cursor-opus","value":"kiro-opus"},{"key":"kiro-opus","value":"claude-opus-5"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want 400", rec.Code, rec.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
		Index *int   `json:"index"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(resp.Error, `"kiro-opus"`) || resp.Index == nil || *resp.Index != 0 {
		t.Fatalf("expected a message naming the chained target at index 0, got %+v", resp)
	}
	if got := config.GetModelMappings(); len(got) != len(before) {
		t.Fatalf("rejected save changed mappings: %#v", got)
	}
}

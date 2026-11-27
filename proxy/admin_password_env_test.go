package proxy

import (
	"encoding/json"
	"net/http"
	"testing"
)

// ADMIN_PASSWORD puts its password back at every start, so a password changed in the admin
// panel lasts only until the next restart. GET /settings says so for the panel to show.
func TestSettingsReportAdminPasswordFromEnv(t *testing.T) {
	for _, tc := range []struct {
		env  string
		want bool
	}{{"", false}, {"from-the-environment", true}} {
		t.Setenv("ADMIN_PASSWORD", tc.env)
		h := newRegionTestAdmin(t)
		rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/settings", "")
		var body struct {
			AdminPasswordFromEnv *bool `json:"adminPasswordFromEnv"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("GET /settings: %d %s", rec.Code, rec.Body.String())
		}
		if body.AdminPasswordFromEnv == nil || *body.AdminPasswordFromEnv != tc.want {
			t.Fatalf("ADMIN_PASSWORD=%q: adminPasswordFromEnv = %v, want %v", tc.env, body.AdminPasswordFromEnv, tc.want)
		}
	}
}

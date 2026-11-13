package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"kiro-proxy/config"
)

// An export imported back into the same backend updates its API key accounts instead of failing
// them as "already added", and the file's notes and tags join the stored ones.
func TestReimportIntoTheSameBackendUpdatesAnAPIKeyAccount(t *testing.T) {
	h := newRegionTestAdmin(t)
	modelCalls := stubImportNetwork(t)

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials",
		`{"kiroApiKey":"ksk_meta|eu-central-1","nickname":"cli","notes":"keep me","tags":["Team-A"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("seed: %d %s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_meta")
	seeded := config.GetAccounts()[0]

	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials",
		`{"kiroApiKey":"ksk_meta","region":"eu-central-1","authMethod":"api_key","nickname":"other","notes":"file notes","tags":["team-a","backup"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-import: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Account struct {
			ID      string `json:"id"`
			Updated bool   `json:"updated"`
		} `json:"account"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Account.ID != seeded.ID || !body.Account.Updated {
		t.Fatalf("re-import response = %s", rec.Body.String())
	}
	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("re-import made %d accounts", len(accounts))
	}
	got := accounts[0]
	if got.Notes != "keep me" || !reflect.DeepEqual(got.Tags, []string{"Team-A", "backup"}) || got.Nickname != "cli" {
		t.Fatalf("notes=%q tags=%q nickname=%q", got.Notes, got.Tags, got.Nickname)
	}

	// The same key with another region is still refused.
	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials", `{"kiroApiKey":"ksk_meta|us-east-1"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("another region: %d %s", rec.Code, rec.Body.String())
	}
}

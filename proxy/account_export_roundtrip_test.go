package proxy

import (
	"encoding/json"
	"kiro-proxy/config"
	"net/http"
	"testing"
)

func TestAPIKeyAccountSurvivesExportImportRoundTrip(t *testing.T) {
	h := newRegionTestAdmin(t)
	modelCalls := stubImportNetwork(t)

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials",
		`{"kiroApiKey":"ksk_roundtrip|eu-central-1","authMethod":"api_key","nickname":"cli-key"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("seed import: %d %s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_roundtrip")
	id := config.GetAccounts()[0].ID

	rec = serveRegionTestAdmin(h, http.MethodGet, "/admin/api/accounts/"+id+"/full", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("full: %d %s", rec.Code, rec.Body.String())
	}
	fullBody := rec.Body.String()
	var full map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &full); err != nil {
		t.Fatalf("decode full: %v", err)
	}
	if full["kiroApiKey"] != "ksk_roundtrip" {
		t.Fatalf("full account must carry kiroApiKey, got %v", full["kiroApiKey"])
	}

	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/export", `{"ids":["`+id+`"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	var exported struct {
		Accounts []struct {
			Credentials json.RawMessage `json:"credentials"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &exported); err != nil || len(exported.Accounts) != 1 {
		t.Fatalf("decode export (%v): %s", err, rec.Body.String())
	}
	var credentials map[string]interface{}
	_ = json.Unmarshal(exported.Accounts[0].Credentials, &credentials)
	if credentials["kiroApiKey"] != "ksk_roundtrip" || credentials["region"] != "eu-central-1" {
		t.Fatalf("export credentials must carry kiroApiKey and region, got %v", credentials)
	}

	for name, body := range map[string]string{
		"export credentials": string(exported.Accounts[0].Credentials),
		"full account":       fullBody,
	} {
		t.Run(name, func(t *testing.T) {
			if err := config.Init(tempDBPath(t)); err != nil {
				t.Fatalf("config.Init: %v", err)
			}
			config.SetPassword("admin-password")
			rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials", body)
			if rec.Code != http.StatusOK {
				t.Fatalf("re-import: %d %s", rec.Code, rec.Body.String())
			}
			waitForModelRefresh(t, modelCalls, "Bearer ksk_roundtrip")
			accounts := config.GetAccounts()
			if len(accounts) != 1 {
				t.Fatalf("expected one re-imported account, got %d", len(accounts))
			}
			got := accounts[0]
			if !config.IsAPIKeyAccount(&got) || got.KiroApiKey != "ksk_roundtrip" || got.Region != "eu-central-1" {
				t.Fatalf("re-imported account lost its API key identity: %+v", got)
			}
		})
	}
}

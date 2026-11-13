package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

type batchResponse struct {
	Success   bool            `json:"success"`
	Count     int             `json:"count"`
	Refreshed int             `json:"refreshed"`
	Failed    int             `json:"failed"`
	Results   []accountResult `json:"results"`
}

func runBatch(t *testing.T, h *Handler, body string) batchResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/api/accounts/batch", strings.NewReader(body))
	h.apiBatchAccounts(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch %s: status=%d body=%s", body, rec.Code, rec.Body.String())
	}
	var out batchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	return out
}

func TestBatchEnableCountsMatchedAccountsOnly(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, id := range []string{"a", "b"} {
		if err := config.AddAccount(config.Account{ID: id, BanStatus: "DISABLED"}); err != nil {
			t.Fatalf("add account %s: %v", id, err)
		}
	}
	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}

	got := runBatch(t, h, `{"ids":["a","b","b","missing"],"action":"enable"}`)
	if got.Count != 2 || got.Failed != 1 || len(got.Results) != 3 {
		t.Fatalf("enable counts = %+v", got)
	}
	if missing := got.Results[2]; missing.ID != "missing" || missing.OK || missing.Status != accountStatusNotFound {
		t.Fatalf("missing id result = %+v", missing)
	}
	for _, acc := range config.GetAccounts() {
		if !acc.Enabled || acc.BanStatus != "ACTIVE" {
			t.Fatalf("account %s not enabled: %+v", acc.ID, acc)
		}
	}

	got = runBatch(t, h, `{"ids":["a"],"action":"disable"}`)
	if got.Count != 1 || got.Failed != 0 || !got.Results[0].OK {
		t.Fatalf("disable counts = %+v", got)
	}
}

func TestBatchRefreshAndRefreshModelsReportUnknownIDs(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}

	for _, action := range []string{"refresh", "refreshModels"} {
		got := runBatch(t, h, `{"ids":["gone"],"action":"`+action+`"}`)
		if got.Refreshed != 0 || got.Failed != 1 || len(got.Results) != 1 || got.Results[0].Status != accountStatusNotFound {
			t.Fatalf("%s response = %+v", action, got)
		}
	}
}

func TestBatchRejectsUnknownAction(t *testing.T) {
	h := &Handler{pool: accountpool.GetPool()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/admin/api/accounts/batch", strings.NewReader(`{"ids":["a"],"action":"explode"}`))
	h.apiBatchAccounts(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

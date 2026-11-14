package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

type breakdownRow struct {
	ts               int64
	keyID, key       string
	model, accountID string
	success          bool
	credits          float64
}

func insertBreakdownRows(t *testing.T, rows ...breakdownRow) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		success := 0
		if row.success {
			success = 1
		}
		if _, err := d.Exec(`INSERT INTO requests (ts, api_key_id, api_key, model, account_id, in_tokens, out_tokens, total_tokens, credits, success) VALUES (?, ?, ?, ?, ?, 10, 5, 15, ?, ?)`,
			row.ts, row.keyID, row.key, row.model, row.accountID, row.credits, success); err != nil {
			t.Fatal(err)
		}
	}
}

func mustBreakdown(t *testing.T, now time.Time, rangeName, ref string) apiKeyUsageBreakdown {
	t.Helper()
	rng, ok := parseUsageRange(rangeName)
	if !ok {
		t.Fatalf("range %q", rangeName)
	}
	resp, err := queryApiKeyUsageBreakdown(now, rng, 0, config.ListApiKeys(), ref)
	if err != nil {
		t.Fatalf("queryApiKeyUsageBreakdown: %v", err)
	}
	return resp
}

func breakdownItem(t *testing.T, items []usageBreakdownItem, id string) usageBreakdownItem {
	t.Helper()
	for _, item := range items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("no item %q in %+v", id, items)
	return usageBreakdownItem{}
}

func TestApiKeyUsageBreakdownByModelAndAccount(t *testing.T) {
	setupApiKeyUsageTest(t)
	active := addUsageKey(t, "laptop", "sk-active-0123456789abcdef", true)
	other := addUsageKey(t, "other", "sk-other-0123456789abcdef", true)
	if err := config.AddAccount(config.Account{ID: "acc-1", Email: "one@example.com", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	ts := now.Unix() - 60
	insertBreakdownRows(t,
		breakdownRow{ts: ts, keyID: active.ID, key: active.Key, model: "claude-sonnet-4.5", accountID: "acc-1", success: true, credits: 1},
		breakdownRow{ts: ts, keyID: active.ID, key: active.Key, model: "claude-sonnet-4.5", accountID: "acc-gone", success: false},
		breakdownRow{ts: ts, keyID: active.ID, key: active.Key, model: "claude-haiku-4.5", accountID: "acc-1", success: true, credits: 0.5},
		// Another key's traffic and keyless traffic stay out of this key's breakdown.
		breakdownRow{ts: ts, keyID: other.ID, key: other.Key, model: "auto", accountID: "acc-1", success: true},
		breakdownRow{ts: ts, model: "auto", accountID: "acc-1", success: true},
		breakdownRow{ts: ts, key: "sk-made-up-0000000000000001", model: "auto", success: false},
		// Three days ago: in 7d, not in 24h.
		breakdownRow{ts: ts - 3*86400, keyID: active.ID, key: active.Key, model: "deepseek-3.2", accountID: "acc-1", success: true},
	)

	day := breakdownRowsByDay(t, now)
	resp := mustBreakdown(t, now, "24h", "key:"+active.ID)
	if len(resp.Models) != 2 || resp.Models[0].ID != "claude-sonnet-4.5" {
		t.Fatalf("models %+v", resp.Models)
	}
	if m := breakdownItem(t, resp.Models, "claude-sonnet-4.5"); m.Requests != 2 || m.Failed != 1 || m.Credits != 1 || m.Tokens != 30 {
		t.Fatalf("sonnet %+v", m)
	}
	if a := breakdownItem(t, resp.Accounts, "acc-1"); a.Requests != 2 || a.Label != "one@example.com" {
		t.Fatalf("acc-1 %+v", a)
	}
	if a := breakdownItem(t, resp.Accounts, "acc-gone"); a.Requests != 1 || a.Label != "" {
		t.Fatalf("a deleted account has no label: %+v", a)
	}

	week := mustBreakdown(t, now, "7d", "key:"+active.ID)
	if m := breakdownItem(t, week.Models, "deepseek-3.2"); m.Requests != 1 {
		t.Fatalf("7d keeps the older row: %+v", week.Models)
	}
	// A pruned row on its day counts in 7d and in the lifetime.
	insertDailyRollup(t, day-2, active.ID, "glm-5", "acc-1", 4)
	week = mustBreakdown(t, now, "7d", "key:"+active.ID)
	if m := breakdownItem(t, week.Models, "glm-5"); m.Requests != 4 {
		t.Fatalf("7d counts the daily rollup: %+v", week.Models)
	}
	// A row pruned before daily totals were kept counts in the lifetime only.
	insertUndatedRollup(t, active.ID, "minimax-m2.1", "acc-1", 6)
	all := mustBreakdown(t, now, "all", "key:"+active.ID)
	if m := breakdownItem(t, all.Models, "minimax-m2.1"); m.Requests != 6 {
		t.Fatalf("lifetime counts the undated rollup: %+v", all.Models)
	}
	if m := breakdownItem(t, all.Models, "glm-5"); m.Requests != 4 {
		t.Fatalf("lifetime counts the daily rollup once: %+v", all.Models)
	}

	none := mustBreakdown(t, now, "24h", "none")
	if len(none.Models) != 1 || none.Models[0].ID != "auto" || none.Models[0].Requests != 1 {
		t.Fatalf("none %+v", none.Models)
	}
	invalid := mustBreakdown(t, now, "24h", "invalid")
	if len(invalid.Models) != 1 || invalid.Models[0].Failed != 1 {
		t.Fatalf("invalid %+v", invalid.Models)
	}
}

// breakdownRowsByDay is the UTC day number of now, the day request_rollup_daily keys by.
func breakdownRowsByDay(t *testing.T, now time.Time) int64 {
	t.Helper()
	return now.Unix() / daySeconds
}

func insertDailyRollup(t *testing.T, day int64, keyID, model, accountID string, n int) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO request_rollup_daily (day, model, account_id, api_key_id, keyless, success, request_count) VALUES (?, ?, ?, ?, 0, 1, ?)`, day, model, accountID, keyID, n); err != nil {
		t.Fatal(err)
	}
	// request_rollup holds every pruned row, the daily ones included.
	if _, err := d.Exec(`INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count) VALUES (?, ?, ?, 1, ?)
ON CONFLICT(model, account_id, api_key_id, success) DO UPDATE SET request_count = request_count + excluded.request_count`, model, accountID, keyID, n); err != nil {
		t.Fatal(err)
	}
}

func insertUndatedRollup(t *testing.T, keyID, model, accountID string, n int) {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO request_rollup (model, account_id, api_key_id, success, request_count) VALUES (?, ?, ?, 1, ?)`, model, accountID, keyID, n); err != nil {
		t.Fatal(err)
	}
}

func TestApiKeyUsageBreakdownRejectsBadRef(t *testing.T) {
	setupApiKeyUsageTest(t)
	h := &Handler{}
	for _, ref := range []string{"", "key:", "nope:1", "none:none", "key"} {
		rec := httptest.NewRecorder()
		h.apiApiKeyUsageBreakdown(rec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/usage/breakdown?ref="+ref, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("ref %q: status %d", ref, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.apiApiKeyUsageBreakdown(rec, httptest.NewRequest(http.MethodGet, "/admin/api/api-keys/usage/breakdown?ref=none&range=7d", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("none: status %d %s", rec.Code, rec.Body.String())
	}
}

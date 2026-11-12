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

// initRoutingAdminConfig starts a fresh config and leaves the routing mode
// weighted afterwards, so a later test's pool rotates again.
func initRoutingAdminConfig(t *testing.T) {
	t.Helper()
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	t.Cleanup(func() { _ = config.UpdateRoutingMode(config.RoutingModeWeighted) })
}

func postSettings(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(body)))
	return rec
}

func getSettingsMap(t *testing.T, h *Handler) map[string]interface{} {
	t.Helper()
	rec := httptest.NewRecorder()
	h.apiGetSettings(rec, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	return got
}

func putAccount(h *Handler, id, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.apiUpdateAccount(rec, httptest.NewRequest(http.MethodPut, "/admin/api/accounts/"+id, strings.NewReader(body)), id)
	return rec
}

func TestAdminSettingsRoutingModeRoundTrip(t *testing.T) {
	initRoutingAdminConfig(t)
	h := &Handler{}

	if got := getSettingsMap(t, h)["routingMode"]; got != config.RoutingModeWeighted {
		t.Fatalf("default routingMode = %#v, want weighted", got)
	}
	for _, mode := range []string{config.RoutingModePriority, config.RoutingModeWeighted, config.RoutingModePriority} {
		rec := postSettings(h, `{"routingMode":"`+mode+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("set %s: status=%d body=%s", mode, rec.Code, rec.Body.String())
		}
		if got := getSettingsMap(t, h)["routingMode"]; got != mode {
			t.Fatalf("GET routingMode = %#v, want %s", got, mode)
		}
		if config.GetRoutingMode() != mode {
			t.Fatalf("config routing mode = %s, want %s", config.GetRoutingMode(), mode)
		}
	}
	// A patch without the key leaves the mode alone.
	if rec := postSettings(h, `{"sessionAffinity":false}`); rec.Code != http.StatusOK {
		t.Fatalf("unrelated patch: status=%d", rec.Code)
	}
	if config.GetRoutingMode() != config.RoutingModePriority {
		t.Fatalf("an unrelated patch changed the routing mode to %s", config.GetRoutingMode())
	}
}

func TestAdminSettingsRejectsInvalidRoutingMode(t *testing.T) {
	initRoutingAdminConfig(t)
	h := &Handler{}

	for _, bad := range []string{`"foo"`, `""`, `"Priority"`} {
		// Sent with another field: a rejected patch must write nothing at all.
		rec := postSettings(h, `{"sessionAffinity":false,"routingMode":`+bad+`}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", bad, rec.Code)
		}
		body := decodeAdminError(t, rec)
		if body["code"] != codeRoutingModeInvalid || body["error"] != `routingMode must be "weighted" or "priority"` {
			t.Fatalf("%s: body = %v", bad, body)
		}
	}
	if rec := postSettings(h, `{"routingMode":2}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("a non-string routingMode: status=%d, want 400", rec.Code)
	}
	if config.GetRoutingMode() != config.RoutingModeWeighted {
		t.Fatalf("a rejected patch changed the routing mode to %s", config.GetRoutingMode())
	}
	if !config.GetSessionAffinity() {
		t.Fatal("a rejected patch still saved sessionAffinity")
	}
}

func TestAdminUpdateAccountPriority(t *testing.T) {
	initRoutingAdminConfig(t)
	if err := config.AddAccount(config.Account{ID: "a", Enabled: true, Nickname: "first"}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}

	if rec := putAccount(h, "a", `{"priority":2}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT priority: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := config.GetAccounts()[0].Priority; got != 2 {
		t.Fatalf("stored priority = %d, want 2", got)
	}
	// The pool copy is reloaded, so the next pick sees the new rank.
	if acc := p.GetByID("a"); acc == nil || acc.Priority != 2 {
		t.Fatalf("pool copy = %+v, want priority 2", acc)
	}
	// A body without the key keeps the priority.
	if rec := putAccount(h, "a", `{"nickname":"renamed"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT nickname: status=%d", rec.Code)
	}
	if got := config.GetAccounts()[0]; got.Priority != 2 || got.Nickname != "renamed" {
		t.Fatalf("account after nickname edit = %+v", got)
	}
	if rec := putAccount(h, "a", `{"priority":999}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT the maximum priority: status=%d", rec.Code)
	}

	rec := httptest.NewRecorder()
	h.apiGetAccounts(rec, httptest.NewRequest(http.MethodGet, "/admin/api/accounts", nil))
	var list []map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 1 {
		t.Fatalf("decode list: %v %s", err, rec.Body.String())
	}
	if list[0]["priority"] != float64(999) {
		t.Fatalf("GET /accounts priority = %#v, want 999", list[0]["priority"])
	}
	rec = httptest.NewRecorder()
	h.apiGetAccountFull(rec, httptest.NewRequest(http.MethodGet, "/admin/api/accounts/a/full", nil), "a")
	var full map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &full); err != nil {
		t.Fatalf("decode full: %v", err)
	}
	if full["priority"] != float64(999) {
		t.Fatalf("GET /accounts/a/full priority = %#v, want 999", full["priority"])
	}
}

func TestAdminUpdateAccountRejectsBadPriority(t *testing.T) {
	initRoutingAdminConfig(t)
	if err := config.AddAccount(config.Account{ID: "a", Enabled: true, Nickname: "first", Priority: 4}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}

	for _, bad := range []string{`-1`, `1000`, `1.5`, `"2"`, `null`, `true`, `1e20`} {
		// Sent with another field: nothing of a rejected body is saved.
		rec := putAccount(h, "a", `{"nickname":"changed","priority":`+bad+`}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("priority %s: status=%d, want 400", bad, rec.Code)
		}
		body := decodeAdminError(t, rec)
		if body["code"] != codePriorityRange || body["error"] != "priority must be an integer between 0 and 999" {
			t.Fatalf("priority %s: body = %v", bad, body)
		}
	}
	if got := config.GetAccounts()[0]; got.Priority != 4 || got.Nickname != "first" {
		t.Fatalf("account after rejected edits = %+v, want it unchanged", got)
	}

	// POST /accounts checks the same range.
	rec := httptest.NewRecorder()
	h.apiAddAccount(rec, httptest.NewRequest(http.MethodPost, "/admin/api/accounts", strings.NewReader(`{"id":"b","region":"us-east-1","priority":1000}`)))
	if rec.Code != http.StatusBadRequest || decodeAdminError(t, rec)["code"] != codePriorityRange {
		t.Fatalf("add with priority 1000: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(config.GetAccounts()) != 1 {
		t.Fatal("an account with an out-of-range priority was added")
	}
}

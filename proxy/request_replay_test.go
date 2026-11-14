package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func serveAdminPassword(h *Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Admin-Password", "admin-password")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func claudeTurn(first, last string) string {
	messages := `[{"role":"user","content":"` + first + `"}]`
	if last != "" {
		messages = `[{"role":"user","content":"` + first + `"},{"role":"assistant","content":"ok"},{"role":"user","content":"` + last + `"}]`
	}
	return `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":` + messages + `}`
}

func newReplayTestHandler(t *testing.T, calls *atomic.Int32) *Handler {
	t.Helper()
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeKiroTextResponse(t, w, "hello from kiro")
	})
	config.SetPassword("admin-password")
	h.adminSessions = newAdminSessionStore()
	return h
}

func TestConversationTurnsShareAnIDAndKeepBodies(t *testing.T) {
	var calls atomic.Int32
	h := newReplayTestHandler(t, &calls)
	for _, body := range []string{claudeTurn("plan a trip", ""), claudeTurn("plan a trip", "add a day"), claudeTurn("something else", "")} {
		if rec := postClientAPI(h, "/v1/messages", body); rec.Code != http.StatusOK {
			t.Fatalf("turn: %d %s", rec.Code, rec.Body.String())
		}
	}
	page := getObserveStore().RequestPage(requestQuery{PageSize: 10, Order: "asc"})
	if len(page.Requests) != 3 {
		t.Fatalf("rows %d", len(page.Requests))
	}
	first, second, other := page.Requests[0], page.Requests[1], page.Requests[2]
	if first.ConversationID == "" || first.ConversationID != second.ConversationID || other.ConversationID == first.ConversationID {
		t.Fatalf("conversation ids %q %q %q", first.ConversationID, second.ConversationID, other.ConversationID)
	}
	if !first.HasBody || first.ID == 0 {
		t.Fatalf("first row %+v, want a kept body and an id", first)
	}

	rec := serveAdminPassword(h, http.MethodGet, "/admin/api/observe/recent-requests?conversation="+first.ConversationID, "")
	var filtered requestPage
	if err := json.Unmarshal(rec.Body.Bytes(), &filtered); err != nil || filtered.Total != 2 {
		t.Fatalf("filtered log: %d %s", rec.Code, rec.Body.String())
	}

	rec = serveAdminPassword(h, http.MethodGet, "/admin/api/observe/conversations/"+first.ConversationID, "")
	var view conversationView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("conversation: %d %s", rec.Code, rec.Body.String())
	}
	if len(view.Turns) != 2 || view.Turns[0].ID != first.ID || view.Totals.Requests != 2 || view.Totals.Successes != 2 || len(view.Totals.Accounts) != 1 {
		t.Fatalf("conversation view %+v", view)
	}
	if rec := serveAdminPassword(h, http.MethodGet, "/admin/api/observe/conversations/missing", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown conversation: %d", rec.Code)
	}

	rec = serveAdminPassword(h, http.MethodGet, "/admin/api/observe/requests/"+itoa(first.ID)+"/body", "")
	var body struct {
		Endpoint string `json:"endpoint"`
		Model    string `json:"model"`
		Body     string `json:"body"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Endpoint != requestEndpointClaude || body.Model != "claude-sonnet-4.5" || !strings.Contains(body.Body, "plan a trip") {
		t.Fatalf("body: %d %s", rec.Code, rec.Body.String())
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestReplayRunsOnTheChosenAccountAndModel(t *testing.T) {
	var calls atomic.Int32
	h := newReplayTestHandler(t, &calls)
	if rec := postClientAPI(h, "/v1/messages", `{"model":"claude-sonnet-4.5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`); rec.Code != http.StatusOK {
		t.Fatalf("original: %d", rec.Code)
	}
	original := lastRecordedRequest(t)
	before := calls.Load()

	rec := serveAdminPassword(h, http.MethodPost, "/admin/api/observe/requests/"+itoa(original.ID)+"/replay", `{"accountId":"only","model":"claude-haiku-4.5"}`)
	var out struct {
		Status   int             `json:"status"`
		Response json.RawMessage `json:"response"`
		Request  requestRecord   `json:"request"`
		Model    string          `json:"model"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
	if out.Status != http.StatusOK || !strings.Contains(string(out.Response), "hello from kiro") || calls.Load() != before+1 {
		t.Fatalf("replay result %+v (%s)", out, out.Response)
	}
	if out.Request.ReplayOf != original.ID || out.Request.Model != "claude-haiku-4.5" || out.Request.ID == original.ID || out.Request.AccountID != "only" {
		t.Fatalf("replay row %+v", out.Request)
	}

	for _, c := range []struct {
		path, body string
		status     int
	}{
		{"/admin/api/observe/requests/" + itoa(original.ID) + "/replay", `{"accountId":"nobody"}`, http.StatusBadRequest},
		{"/admin/api/observe/requests/999999/replay", `{}`, http.StatusNotFound},
		{"/admin/api/observe/requests/abc/replay", `{}`, http.StatusNotFound},
	} {
		if rec := serveAdminPassword(h, http.MethodPost, c.path, c.body); rec.Code != c.status {
			t.Errorf("%s %s: %d %s, want %d", c.path, c.body, rec.Code, rec.Body.String(), c.status)
		}
	}
	// Replays are admin only.
	req := httptest.NewRequest(http.MethodPost, "/admin/api/observe/requests/"+itoa(original.ID)+"/replay", strings.NewReader(`{}`))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replay without admin: %d", rec.Code)
	}
}

func TestKeptBodyMasksTheClientKeyAndSkipsHugeBodies(t *testing.T) {
	var calls atomic.Int32
	h := newReplayTestHandler(t, &calls)
	const key = "sk-test-replay-key-0123456789"
	if _, err := config.AddApiKey(config.ApiKeyEntry{ID: "k1", Name: "test", Key: key, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := config.UpdateSettingsPatch(boolPtr(true), ""); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(claudeTurn("my key is "+key, "")))
	req.Header.Set("x-api-key", key)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("request: %d %s", rec.Code, rec.Body.String())
	}
	stored, err := loadRequestBody(lastRecordedRequest(t).ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored.Body), key) || !strings.Contains(string(stored.Body), config.MaskApiKey(key)) {
		t.Fatalf("kept body %s", stored.Body)
	}

	huge := claudeTurn(strings.Repeat("x", maxStoredBodyBytes), "")
	req = httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(huge))
	req.Header.Set("x-api-key", key)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if last := lastRecordedRequest(t); last.HasBody {
		t.Fatalf("a body over %d bytes was kept: %+v", maxStoredBodyBytes, last.ID)
	}
	// A request turned away before an account is chosen keeps no body.
	req = httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(claudeTurn("no key", "")))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if last := lastRecordedRequest(t); last.HasBody || last.Success {
		t.Fatalf("a rejected request kept its body: %+v", last)
	}
}

func boolPtr(v bool) *bool { return &v }

func TestPruneRequestBodies(t *testing.T) {
	newObserveStoreForTest(t)
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	insertRow := func(ts int64) int64 {
		id, err := persistRequestRecord(requestRecord{TS: ts, AccountID: "a", Model: "m", Success: true})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	old := insertRow(now.Add(-31 * 24 * time.Hour).Unix())
	fresh := insertRow(now.Unix())
	newer := insertRow(now.Unix() + 1)
	for _, row := range []struct {
		id, ts int64
		size   int
	}{{old, now.Add(-31 * 24 * time.Hour).Unix(), 10}, {fresh, now.Unix(), 600}, {newer, now.Unix() + 1, 600}, {999999, now.Unix(), 10}} {
		if _, err := d.Exec(`INSERT INTO request_bodies (request_id, created_at, endpoint, size, stored_size, body) VALUES (?, ?, 'claude', ?, ?, x'00')`, row.id, row.ts, row.size, row.size); err != nil {
			t.Fatal(err)
		}
	}
	prev := maxRequestBodiesBytes
	maxRequestBodiesBytes = 1000
	t.Cleanup(func() { maxRequestBodiesBytes = prev })
	if err := pruneRequestBodies(now); err != nil {
		t.Fatal(err)
	}
	rows, err := d.Query(`SELECT request_id FROM request_bodies ORDER BY request_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var kept []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		kept = append(kept, id)
	}
	if len(kept) != 1 || kept[0] != newer {
		t.Fatalf("kept %v, want only the newest (%d)", kept, newer)
	}
}

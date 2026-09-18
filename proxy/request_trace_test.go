package proxy

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func TestClassifyRequestError(t *testing.T) {
	cases := []struct {
		name    string
		success bool
		status  int
		message string
		want    string
	}{
		{"success", true, 200, "", ""},
		{"client closed", false, 499, "client disconnected", "client_closed"},
		{"api key token limit", false, 429, "token limit exceeded", "api_key_limit"},
		{"api key credit limit", false, 429, "credit limit exceeded", "api_key_limit"},
		{"overage", false, 500, "HTTP 402: overage is not enabled", "overage"},
		{"quota", false, 500, "HTTP 429: monthly quota reached", "quota"},
		{"suspended before auth", false, 500, "HTTP 403: TEMPORARILY_SUSPENDED", "suspended"},
		{"profile", false, 500, "no available Kiro profile in eu-central-1", "profile"},
		{"auth message", false, 500, "HTTP 403: Forbidden", "auth"},
		{"auth status", false, 401, "Invalid or missing API key", "auth"},
		{"truncated stream", false, 500, errUpstreamTruncatedResponse.Error(), "stream"},
		{"incomplete tool input", false, 500, errIncompleteKiroToolInput.Error(), "stream"},
		{"bad event stream", false, 500, errInvalidKiroEventStream.Error(), "stream"},
		{"no accounts", false, 503, "No available accounts", "no_accounts"},
		{"invalid json", false, 400, "Invalid JSON", "invalid_request"},
		{"method", false, 405, "Method Not Allowed", "invalid_request"},
		{"plain 429", false, 429, "Too many requests", "rate_limit"},
		{"timeout", false, 500, "context deadline exceeded", "timeout"},
		{"upstream", false, 500, "HTTP 500: internal error", "upstream"},
		{"unknown", false, 404, "not found", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyRequestError(tc.success, tc.status, tc.message); got != tc.want {
				t.Fatalf("classifyRequestError(%v, %d, %q) = %q, want %q", tc.success, tc.status, tc.message, got, tc.want)
			}
		})
	}
}

func TestRequestEndpointForPath(t *testing.T) {
	cases := map[string]string{
		"/v1/messages":              requestEndpointClaude,
		"/anthropic/v1/messages":    requestEndpointClaude,
		"/chat/completions":         requestEndpointOpenAI,
		"/v1/responses":             requestEndpointResponses,
		"/v1/messages/count_tokens": "",
		"/v1/responses/resp_1":      "",
		"/v1/models":                "",
	}
	for path, want := range cases {
		if got := requestEndpointForPath(path); got != want {
			t.Errorf("requestEndpointForPath(%q) = %q, want %q", path, got, want)
		}
	}
}

func setupTraceTestStore(t *testing.T) *observeStore {
	t.Helper()
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return getObserveStore()
}

func TestServeHTTPTracesEarlyFailures(t *testing.T) {
	s := setupTraceTestStore(t)
	h := &Handler{}

	for _, tc := range []struct{ path, endpoint string }{
		{"/v1/messages", requestEndpointClaude},
		{"/v1/chat/completions", requestEndpointOpenAI},
		{"/v1/responses", requestEndpointResponses},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader("{not json")))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body=%s", tc.path, rec.Code, rec.Body.String())
		}
		got := s.RecentRequests(1)
		if len(got) != 1 {
			t.Fatalf("%s: expected one recorded request, got %d", tc.path, len(got))
		}
		if got[0].Endpoint != tc.endpoint || got[0].ErrorType != "invalid_request" {
			t.Fatalf("%s: endpoint=%q errorType=%q", tc.path, got[0].Endpoint, got[0].ErrorType)
		}
	}

	page := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: requestEndpointResponses})
	if !page.Persistent || page.Total != 1 || page.Requests[0].Endpoint != requestEndpointResponses {
		t.Fatalf("expected persisted endpoint to be searchable, got persistent=%v total=%d rows=%#v", page.Persistent, page.Total, page.Requests)
	}
}

func TestServeHTTPTracesAuthFailure(t *testing.T) {
	s := setupTraceTestStore(t)
	require := true
	if err := config.UpdateSettingsPatch(&require, ""); err != nil {
		t.Fatalf("enable auth: %v", err)
	}
	if _, err := config.AddApiKey(config.ApiKeyEntry{Name: "trace", Key: "sk-trace", Enabled: true}); err != nil {
		t.Fatalf("add key: %v", err)
	}

	rec := httptest.NewRecorder()
	h := &Handler{}
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
	got := s.RecentRequests(1)
	if len(got) != 1 || got[0].Endpoint != requestEndpointOpenAI || got[0].ErrorType != "auth" {
		t.Fatalf("expected an auth failure on the openai endpoint, got %#v", got)
	}
}

func TestServeHTTPRecordsDurationOnSuccess(t *testing.T) {
	const upstreamDelay = 40 * time.Millisecond
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(upstreamDelay)
		writeFrames(w,
			awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hello"}),
			meteringFrame(t),
		)
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	got := getObserveStore().RecentRequests(1)
	if len(got) != 1 {
		t.Fatalf("expected one recorded request, got %d", len(got))
	}
	r := got[0]
	if !r.Success || r.Endpoint != requestEndpointOpenAI || r.ErrorType != "" {
		t.Fatalf("unexpected success record: %#v", r)
	}
	if r.DurationMs < upstreamDelay.Milliseconds() {
		t.Fatalf("durationMs = %d, want at least the %dms upstream wait", r.DurationMs, upstreamDelay.Milliseconds())
	}
}

func TestRequestPageSortsByDuration(t *testing.T) {
	s := setupTraceTestStore(t)
	defer s.Reset()

	now := time.Now()
	for _, d := range []time.Duration{2 * time.Second, 50 * time.Millisecond, 700 * time.Millisecond} {
		trace := &requestTrace{startedAt: now.Add(-d), endpoint: requestEndpointClaude}
		s.RecordTracedRequest(trace, "acc", "", "", "a@example.com", "claude-sonnet-4.5", 1, 1, 0, true, 200, "")
	}
	s.RecordRequest("acc", "a@example.com", "claude-sonnet-4.5", 1, 1, 0, true, 200, "")

	check := func(page requestPage, want []int64) {
		t.Helper()
		if len(page.Requests) != len(want) {
			t.Fatalf("got %d rows, want %d", len(page.Requests), len(want))
		}
		for i, rec := range page.Requests {
			//! Durations are measured, so compare to the nearest 100ms.
			if (rec.DurationMs+50)/100 != (want[i]+50)/100 {
				t.Fatalf("row %d durationMs = %d, want about %d (persistent=%v)", i, rec.DurationMs, want[i], page.Persistent)
			}
		}
	}

	persisted := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Sort: "duration", Order: "desc"})
	if !persisted.Persistent {
		t.Fatalf("expected sqlite-backed request page")
	}
	check(persisted, []int64{2000, 700, 50, 0})
	check(s.memoryRequestPage(normalizeRequestQuery(requestQuery{Sort: "duration", Order: "asc"})), []int64{0, 50, 700, 2000})
}

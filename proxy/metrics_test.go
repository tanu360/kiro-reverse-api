package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func scrape(h *Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestMetricsEndpointIsOffUntilTurnedOnAndNeedsTheToken(t *testing.T) {
	var calls atomic.Int32
	h := newReplayTestHandler(t, &calls)
	metrics = newMetricsRegistry()
	t.Cleanup(func() { metrics = newMetricsRegistry() })

	if rec := scrape(h, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("off: %d", rec.Code)
	}
	rec := serveAdminPassword(h, http.MethodPost, "/admin/api/metrics", `{"enabled":true}`)
	var settings struct {
		Enabled bool   `json:"enabled"`
		Token   string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &settings); err != nil || !settings.Enabled || !strings.HasPrefix(settings.Token, "kpm_") {
		t.Fatalf("enable: %d %s", rec.Code, rec.Body.String())
	}
	if rec := scrape(h, ""); rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") == "" {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := scrape(h, "kpm_wrong"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", rec.Code)
	}

	if rec := postClientAPI(h, "/v1/messages", claudeTurn("count me", "")); rec.Code != http.StatusOK {
		t.Fatalf("request: %d", rec.Code)
	}
	rec = scrape(h, settings.Token)
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("scrape: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	text := rec.Body.String()
	for _, want := range []string{
		`kiro_requests_total{outcome="success",status="200",model="claude-sonnet-4.5",account="only",api_key="none"} 1`,
		`kiro_tokens_total{kind="output",model="claude-sonnet-4.5",account="only",api_key="none"}`,
		`kiro_request_duration_seconds_bucket{endpoint="claude",outcome="success",le="+Inf"} 1`,
		`kiro_request_duration_seconds_count{endpoint="claude",outcome="success"} 1`,
		`kiro_account_state{account="only",state="active"} 1`,
		`kiro_accounts{state="active"} 1`,
		`kiro_proxies{state="healthy"} 0`,
		"# TYPE kiro_upstream_errors_total counter",
		"# TYPE kiro_credits_total counter",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("scrape lacks %q", want)
		}
	}
	checkExposition(t, text)

	// A new token locks the old one out.
	rec = serveAdminPassword(h, http.MethodPost, "/admin/api/metrics", `{"regenerate":true}`)
	var fresh struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &fresh)
	if fresh.Token == settings.Token || scrape(h, settings.Token).Code != http.StatusUnauthorized || scrape(h, fresh.Token).Code != http.StatusOK {
		t.Fatal("regenerating the token did not replace it")
	}
	serveAdminPassword(h, http.MethodPost, "/admin/api/metrics", `{"enabled":false}`)
	if rec := scrape(h, fresh.Token); rec.Code != http.StatusNotFound {
		t.Fatalf("off again: %d", rec.Code)
	}
}

// checkExposition checks the text format's shape: every sample's family was
// declared with HELP and TYPE before it, and each family appears once.
func checkExposition(t *testing.T, text string) {
	t.Helper()
	declared := map[string]bool{}
	current := ""
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		if strings.HasPrefix(line, "# TYPE ") {
			name := strings.Fields(line)[2]
			if declared[name] {
				t.Errorf("family %s declared twice", name)
			}
			declared[name] = true
			current = name
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		name := line
		if i := strings.IndexAny(line, "{ "); i >= 0 {
			name = line[:i]
		}
		base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(name, "_bucket"), "_sum"), "_count")
		if base != current && name != current {
			t.Errorf("sample %q outside its family (current %s)", line, current)
		}
	}
}

func TestMetricsLabelEscaping(t *testing.T) {
	got := labels("a", "x\"y\\z\nw")
	if got != `{a="x\"y\\z\nw"}` {
		t.Fatalf("labels %s", got)
	}
}

func TestUpstreamErrorMetricCounts(t *testing.T) {
	h := newRegionTestAdmin(t)
	metrics = newMetricsRegistry()
	t.Cleanup(func() { metrics = newMetricsRegistry() })
	recordUpstreamErrorMetric("a1", "a1@example.com", http.StatusTooManyRequests, "HTTP 429 from kiro: Too many requests")
	recordUpstreamErrorMetric("a1", "a1@example.com", http.StatusTooManyRequests, "HTTP 429 from kiro: Too many requests")
	recordUpstreamErrorMetric("a2", "", 0, "context deadline exceeded")
	text := h.renderMetrics()
	for _, want := range []string{
		`kiro_upstream_errors_total{category="quota",account="a1@example.com"} 2`,
		`kiro_upstream_errors_total{category="timeout",account="a2"} 1`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("metrics lack %s:\n%s", want, text)
		}
	}
}

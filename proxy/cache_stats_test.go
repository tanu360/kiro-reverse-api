package proxy

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func cacheUsageFrames(t *testing.T) [][]byte {
	return [][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}),
		awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{
			"stopReason": "end_turn",
			"tokenUsage": map[string]interface{}{
				"uncachedInputTokens":   10,
				"cacheReadInputTokens":  300,
				"cacheWriteInputTokens": 40,
				"outputTokens":          5,
			},
		}),
	}
}

func TestParseEventStreamReportsUpstreamCacheTokens(t *testing.T) {
	var in, out, read, write int
	err := parseFrames(t, &KiroStreamCallback{
		OnComplete:   func(i, o int) { in, out = i, o },
		OnCacheUsage: func(r, w int) { read, write = r, w },
	}, cacheUsageFrames(t)...)
	if err != nil {
		t.Fatal(err)
	}
	if in != 350 || out != 5 || read != 300 || write != 40 {
		t.Fatalf("in=%d out=%d cacheRead=%d cacheWrite=%d", in, out, read, write)
	}

	called := false
	err = parseFrames(t, &KiroStreamCallback{OnCacheUsage: func(int, int) { called = true }},
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}),
		awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "end_turn", "usage": map[string]interface{}{"inputTokens": 12}}),
	)
	if err != nil || called {
		t.Fatalf("cache callback without cache fields: err=%v called=%v", err, called)
	}
}

func TestResolveCacheTokensPrefersUpstreamAndStaysWithinInput(t *testing.T) {
	cases := []struct {
		name               string
		upstream, estimate cacheTokenCounts
		input              int
		want               cacheTokenCounts
	}{
		{"upstream wins", cacheTokenCounts{Read: 30, Write: 5}, cacheTokenCounts{Read: 900}, 100, cacheTokenCounts{Read: 30, Write: 5}},
		{"estimate fallback", cacheTokenCounts{}, cacheTokenCounts{Read: 60, Write: 20}, 100, cacheTokenCounts{Read: 60, Write: 20}},
		{"clamped to input", cacheTokenCounts{}, cacheTokenCounts{Read: 80, Write: 50}, 100, cacheTokenCounts{Read: 80, Write: 20}},
		{"no input", cacheTokenCounts{Read: 5}, cacheTokenCounts{}, 0, cacheTokenCounts{}},
	}
	for _, tc := range cases {
		if got := resolveCacheTokens(tc.upstream, tc.estimate, tc.input); got != tc.want {
			t.Fatalf("%s: got %+v want %+v", tc.name, got, tc.want)
		}
	}
}

func TestObserveStoreTracksCacheTokensSeparately(t *testing.T) {
	s := newObserveStoreForTest(t)
	s.RecordTracedRequestWithCache(nil, "acc", "", "", "", "m", 100, 10, 0.1, true, 200, "", cacheTokenCounts{})
	s.RecordTracedRequestWithCache(nil, "acc", "", "", "", "m", 400, 20, 0.2, true, 200, "", cacheTokenCounts{Read: 300, Write: 50})

	mix := s.ModelMix()
	if len(mix) != 1 {
		t.Fatalf("mix = %+v", mix)
	}
	got := mix[0]
	if got.InTokens != 500 || got.OutTokens != 30 || got.CacheReadTokens != 300 || got.CacheWriteTokens != 50 {
		t.Fatalf("model stat = %+v", got)
	}
	slot, curMin := curSlot(time.Now().Unix())
	if b := s.globalRing[slot]; b.WindowMin == curMin && (b.CacheReadTokens != 300 || b.CacheWriteTokens != 50 || b.InTokens != 500) {
		t.Fatalf("global bucket = %+v", b)
	}
}

func TestRequestRecordsPersistCacheTokens(t *testing.T) {
	resetObservePersistenceForTest(t)
	dir := t.TempDir()
	if err := db.ResetForTest(dir); err != nil {
		t.Fatal(err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatal(err)
	}
	s := getObserveStore()
	s.RecordTracedRequestWithCache(nil, "acc", "", "", "a@example.com", "m", 400, 20, 0.2, true, 200, "", cacheTokenCounts{Read: 300, Write: 50})

	if mem := s.RecentRequests(1); len(mem) != 1 || mem[0].CacheRead != 300 || mem[0].CacheWrite != 50 || mem[0].TotalTokens != 420 {
		t.Fatalf("memory record = %+v", mem)
	}
	page, err := queryPersistedRequests(requestQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Requests) != 1 || page.Requests[0].CacheRead != 300 || page.Requests[0].CacheWrite != 50 || page.Requests[0].InTokens != 400 {
		t.Fatalf("persisted page = %+v", page.Requests)
	}
	loaded, err := loadRecentRequestsFromDB(1)
	if err != nil || len(loaded) != 1 || loaded[0].CacheRead != 300 || loaded[0].CacheWrite != 50 {
		t.Fatalf("loaded = %+v err=%v", loaded, err)
	}
}

func TestClaudeAndOpenAIRecordUpstreamCacheTokens(t *testing.T) {
	for _, endpoint := range []string{"claude", "openai"} {
		t.Run(endpoint, func(t *testing.T) {
			h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
				writeFrames(w, cacheUsageFrames(t)...)
			})
			rec := httptest.NewRecorder()
			if endpoint == "claude" {
				req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
				h.handleClaudeNonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, claudeThinkingResponseOptions{}, 1, nil, nil)
			} else {
				req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
				h.handleOpenAINonStream(rec, req, testKiroPayload(), "claude-sonnet-4.5", false, 1, nil)
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
			}
			reqs := getObserveStore().RecentRequests(1)
			if len(reqs) != 1 || reqs[0].InTokens != 350 || reqs[0].CacheRead != 300 || reqs[0].CacheWrite != 40 {
				t.Fatalf("request record = %+v", reqs)
			}
			mix := getObserveStore().ModelMix()
			if len(mix) != 1 || mix[0].CacheReadTokens != 300 || mix[0].CacheWriteTokens != 40 {
				t.Fatalf("model mix = %+v", mix)
			}
		})
	}
}

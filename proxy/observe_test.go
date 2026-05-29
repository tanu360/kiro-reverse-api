package proxy

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

func resetObservePersistenceForTest(t *testing.T) {
	t.Helper()
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	t.Cleanup(func() {
		observeStoreOnce = sync.Once{}
		observeStoreInst = nil
	})
}

func TestObserveStore_RecordAndOverview(t *testing.T) {

	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	_ = time.Now()
	s := getObserveStore()
	defer s.Reset()

	s.RecordSuccess("acc1", "claude-sonnet-4-6", 100, 50, 0.5)
	s.RecordSuccess("acc1", "claude-sonnet-4-6", 200, 80, 0.8)
	s.RecordFailure("acc1", "claude-opus-4-7")
	s.RecordError("acc1", "a@b.c", "claude-opus-4-7", 500, "boom")

	o := s.Overview()
	if o.RPM1 < 3 {
		t.Fatalf("expected RPM1 >= 3, got %d", o.RPM1)
	}
	if o.Successes60 != 2 {
		t.Fatalf("expected 2 successes, got %d", o.Successes60)
	}
	if o.Errors60 != 1 {
		t.Fatalf("expected 1 error, got %d", o.Errors60)
	}
	if o.ActiveAccts != 1 {
		t.Fatalf("expected 1 active account, got %d", o.ActiveAccts)
	}
	if o.TotalModels != 2 {
		t.Fatalf("expected 2 models tracked, got %d", o.TotalModels)
	}
}

func TestObserveStore_HeatmapShape(t *testing.T) {
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	s := getObserveStore()
	defer s.Reset()

	s.RecordSuccess("acc1", "claude-sonnet-4-6", 10, 10, 0.1)
	hm := s.Heatmap(30)
	if hm.WindowMin != 30 {
		t.Fatalf("WindowMin = %d", hm.WindowMin)
	}
	if len(hm.Global.Cells) != 30 {
		t.Fatalf("global cells len = %d", len(hm.Global.Cells))
	}
	if len(hm.Accounts) != 1 {
		t.Fatalf("accounts len = %d", len(hm.Accounts))
	}
	if hm.Global.Cells[0].Reqs < 1 {
		t.Fatalf("expected current minute reqs >= 1, got %d", hm.Global.Cells[0].Reqs)
	}
}

func TestObserveStore_RecentErrorsOrdering(t *testing.T) {
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	s := getObserveStore()
	defer s.Reset()

	for i := 0; i < 5; i++ {
		s.RecordError("acc", "e@x", "m", 500, "err-"+string(rune('a'+i)))
	}
	got := s.RecentErrors(3)
	if len(got) != 3 {
		t.Fatalf("expected 3 errors, got %d", len(got))
	}

	if got[0].Message != "err-e" {
		t.Fatalf("expected newest first 'err-e', got %q", got[0].Message)
	}
	if got[2].Message != "err-c" {
		t.Fatalf("expected 3rd 'err-c', got %q", got[2].Message)
	}
}

func TestObserveStore_ModelMixSortedByCredits(t *testing.T) {
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	s := getObserveStore()
	defer s.Reset()

	s.RecordSuccess("a", "low", 10, 10, 0.1)
	s.RecordSuccess("a", "high", 10, 10, 5.0)
	s.RecordSuccess("a", "mid", 10, 10, 1.0)

	mix := s.ModelMix()
	if len(mix) != 3 {
		t.Fatalf("expected 3 models, got %d", len(mix))
	}
	if mix[0].Model != "high" || mix[2].Model != "low" {
		t.Fatalf("unexpected order: %v", mix)
	}
}

func TestObserveStore_RequestPagePersistsAndFilters(t *testing.T) {
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}

	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	s := getObserveStore()
	defer s.Reset()

	s.RecordRequest("acc-ok", "ok@example.com", "claude-sonnet", 10, 20, 0.03, true, 200, "")
	s.RecordRequest("acc-fail", "fail@example.com", "claude-opus", 0, 0, 0, false, 429, "rate limit exceeded")
	s.RecordRequest("acc-percent", "percent@example.com", "literal%model", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("acc-wild", "wild@example.com", "literalXmodel", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("b-id", "same@example.com", "sort-model", 1, 1, 0.01, true, 200, "")
	s.RecordRequest("a-id", "same@example.com", "sort-model", 1, 1, 0.01, true, 200, "")
	keyA := "sk-client-" + strings.Repeat("a", 50) + "middle-a" + strings.Repeat("z", 50)
	keyB := "sk-client-" + strings.Repeat("b", 50) + "middle-b" + strings.Repeat("y", 50)
	s.RecordRequestWithAPIKey("api-acc-a", "key-a", keyA, "api@example.com", "api-model", 1, 1, 0.01, true, 200, "")
	s.RecordRequestWithAPIKey("api-acc-b", "key-b", keyB, "api@example.com", "api-model", 1, 1, 0.01, true, 200, "")

	page := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "rate", Status: "failed", Sort: "time", Order: "desc"})
	if !page.Persistent {
		t.Fatalf("expected sqlite-backed request page")
	}
	if page.Total != 1 || len(page.Requests) != 1 {
		t.Fatalf("expected 1 filtered request, total=%d len=%d", page.Total, len(page.Requests))
	}
	if page.Requests[0].Message != "rate limit exceeded" || page.Requests[0].Status != 429 {
		t.Fatalf("unexpected persisted error request: %#v", page.Requests[0])
	}

	literalPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "literal%", Sort: "time", Order: "desc"})
	if literalPage.Total != 1 || literalPage.Requests[0].Model != "literal%model" {
		t.Fatalf("expected LIKE wildcard to be escaped, got total=%d rows=%#v", literalPage.Total, literalPage.Requests)
	}

	accountPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "same@example.com", Sort: "account", Order: "asc"})
	if accountPage.Total != 2 || accountPage.Requests[0].AccountID != "a-id" {
		t.Fatalf("expected account sort to use email+accountID, got total=%d rows=%#v", accountPage.Total, accountPage.Requests)
	}

	apiKeyPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "sk-client", Sort: "api_key", Order: "asc"})
	if apiKeyPage.Total != 2 || apiKeyPage.Requests[0].APIKeyID != "key-a" || apiKeyPage.Requests[0].APIKeyMasked == "" {
		t.Fatalf("expected API key search/sort with masked value, got total=%d rows=%#v", apiKeyPage.Total, apiKeyPage.Requests)
	}
	hiddenPartPage := s.RequestPage(requestQuery{Page: 1, PageSize: 10, Search: "middle-a", Sort: "api_key", Order: "asc"})
	if hiddenPartPage.Total != 1 || hiddenPartPage.Requests[0].APIKeyID != "key-a" {
		t.Fatalf("expected full API key value to be searchable, got total=%d rows=%#v", hiddenPartPage.Total, hiddenPartPage.Requests)
	}
	body, err := json.Marshal(hiddenPartPage.Requests[0])
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if strings.Contains(string(body), keyA) || strings.Contains(string(body), "middle-a") {
		t.Fatalf("request JSON exposed raw API key: %s", string(body))
	}
}

func TestQueryPersistedRequestStats(t *testing.T) {
	dir := t.TempDir()
	resetObservePersistenceForTest(t)
	if err := db.ResetForTest(dir); err != nil {
		t.Fatalf("reset db: %v", err)
	}
	if err := config.Init(filepath.Join(dir, "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	s := getObserveStore()
	defer s.Reset()
	s.RecordRequest("acc-ok-1", "ok1@example.com", "claude-sonnet", 10, 20, 0.30, true, 200, "")
	s.RecordRequest("acc-fail", "fail@example.com", "claude-opus", 0, 0, 0, false, 500, "boom")
	s.RecordRequest("acc-ok-2", "ok2@example.com", "claude-haiku", 3, 7, 0.20, true, 200, "")
	s.RecordError("acc-fail", "fail@example.com", "claude-opus", 500, "boom")

	stats, err := queryPersistedRequestStats()
	if err != nil {
		t.Fatalf("query stats: %v", err)
	}
	if stats.TotalRequests != 3 || stats.SuccessRequests != 2 || stats.FailedRequests != 1 {
		t.Fatalf("unexpected counts: %#v", stats)
	}
	if stats.TotalTokens != 40 {
		t.Fatalf("expected 40 tokens, got %d", stats.TotalTokens)
	}
	if math.Abs(stats.TotalCredits-0.50) > 0.000001 {
		t.Fatalf("expected 0.50 credits, got %.2f", stats.TotalCredits)
	}
	if stats.SuccessTokens != 40 {
		t.Fatalf("expected 40 success tokens, got %d", stats.SuccessTokens)
	}
	if stats.SuccessInTokens != 13 {
		t.Fatalf("expected 13 success input tokens, got %d", stats.SuccessInTokens)
	}
	if stats.SuccessOutTokens != 27 {
		t.Fatalf("expected 27 success output tokens, got %d", stats.SuccessOutTokens)
	}
	if math.Abs(stats.SuccessCredits-0.50) > 0.000001 {
		t.Fatalf("expected 0.50 success credits, got %.2f", stats.SuccessCredits)
	}
	if stats.TotalErrorEvents != 1 {
		t.Fatalf("expected 1 error event, got %d", stats.TotalErrorEvents)
	}
}

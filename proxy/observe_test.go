package proxy

import (
	"sync"
	"testing"
	"time"
)

func TestObserveStore_RecordAndOverview(t *testing.T) {
	// 重置全局实例以隔离测试（不共享状态）
	observeStoreOnce = sync.Once{}
	observeStoreInst = nil
	_ = time.Now() // satisfy import if pruned
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
	// 最新在前
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

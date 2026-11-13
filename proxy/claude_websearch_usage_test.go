package proxy

import (
	"context"
	"testing"

	"kiro-proxy/config"
	accountpool "kiro-proxy/pool"
)

func TestWebSearchLoopChargesEachRoundToItsAccount(t *testing.T) {
	s := newObserveStoreForTest(t)
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	for _, id := range []string{"a", "b"} {
		if err := config.AddAccount(config.Account{ID: id, Email: id + "@x", Enabled: true}); err != nil {
			t.Fatalf("add account %s: %v", id, err)
		}
	}
	p := accountpool.GetPool()
	p.Reload()
	h := &Handler{pool: p}
	accounts := map[string]config.Account{}
	stored := func() {
		for _, acc := range config.GetAccounts() {
			accounts[acc.ID] = acc
		}
	}

	// Round 1 on a, round 2 failed over to b and answered.
	var usage webSearchLoopUsage
	usage.add("a", 100, 20, 0.5)
	usage.add("b", 50, 10, 0.25)
	last := &config.Account{ID: "b", Email: "b@x"}
	h.recordWebSearchLoop(context.Background(), nil, last, "claude-sonnet", &usage, true, 200, "")
	stored()
	if a := accounts["a"]; a.RequestCount != 0 || a.TotalTokens != 120 || a.TotalCredits != 0.5 {
		t.Fatalf("a = requests %d tokens %d credits %v, want 0, 120, 0.5", a.RequestCount, a.TotalTokens, a.TotalCredits)
	}
	if b := accounts["b"]; b.RequestCount != 1 || b.ErrorCount != 0 || b.TotalTokens != 60 || b.TotalCredits != 0.25 {
		t.Fatalf("b = requests %d tokens %d credits %v, want 1, 60, 0.25", b.RequestCount, b.TotalTokens, b.TotalCredits)
	}
	if rec := s.RecentRequests(1)[0]; rec.AccountID != "b" || rec.InTokens != 150 || rec.OutTokens != 30 || rec.Credits != 0.75 || !rec.Success {
		t.Fatalf("logged request = %+v", rec)
	}

	// Round 1 on a succeeded, then the next round failed on b: a's spend still counts.
	var failed webSearchLoopUsage
	failed.add("a", 10, 0, 0.125)
	h.recordWebSearchLoop(context.Background(), nil, last, "claude-sonnet", &failed, false, 502, "upstream failed")
	stored()
	if a := accounts["a"]; a.RequestCount != 0 || a.TotalCredits != 0.625 {
		t.Fatalf("a after a failed loop = requests %d credits %v", a.RequestCount, a.TotalCredits)
	}
	if b := accounts["b"]; b.RequestCount != 2 || b.ErrorCount != 1 || b.TotalCredits != 0.25 {
		t.Fatalf("b after a failed loop = requests %d errors %d credits %v", b.RequestCount, b.ErrorCount, b.TotalCredits)
	}
	if rec := s.RecentRequests(1)[0]; rec.Success || rec.Credits != 0.125 || rec.Status != 502 {
		t.Fatalf("logged failed request = %+v", rec)
	}
}

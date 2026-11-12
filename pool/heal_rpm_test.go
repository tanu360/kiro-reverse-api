package pool

import (
	"sync"
	"testing"
	"time"

	"kiro-proxy/config"
)

// An account held back only by the per-account RPM limit is healthy: the pool must not
// count it as unservable, or a heal would bring banned accounts back to get around the limit.
func TestHealViewCountsRPMLimitedAccountsAsServable(t *testing.T) {
	setRPMLimitForTest(t, 1)
	p := newTestPool(config.Account{ID: "busy", AccessToken: "t"})
	if acc := p.GetNext(); acc == nil {
		t.Fatal("first pick = nil")
	}
	if acc := p.GetNext(); acc != nil {
		t.Fatalf("second pick = %s, want none at the limit", acc.ID)
	}
	if !p.HealView(time.Now()).Servable {
		t.Fatal("an account at the RPM limit made the pool unservable")
	}
}

// HealView holds the pool's read lock only, so it must not touch the RPM state, which a check
// with the limit off resets (go test -race).
func TestConcurrentHealViewsDoNotWriteRPMState(t *testing.T) {
	setRPMLimitForTest(t, 0)
	p := newTestPool(config.Account{ID: "a", AccessToken: "t"}, config.Account{ID: "b", AccessToken: "t"})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				p.HealView(time.Now())
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				p.GetNext()
			}
		}()
	}
	wg.Wait()
}

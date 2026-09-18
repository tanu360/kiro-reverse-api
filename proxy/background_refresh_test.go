package proxy

import (
	"fmt"
	"kiro-proxy/config"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testAccounts(n int) []config.Account {
	accounts := make([]config.Account, n)
	for i := range accounts {
		accounts[i] = config.Account{ID: fmt.Sprintf("acct-%d", i)}
	}
	return accounts
}

func TestForEachAccountVisitsEveryAccountOnce(t *testing.T) {
	accounts := testAccounts(50)
	visits := make([]int32, len(accounts))

	forEachAccount(accounts, 8, func(i int, account *config.Account) {
		if account.ID != fmt.Sprintf("acct-%d", i) {
			t.Errorf("index %d got account %s", i, account.ID)
		}
		atomic.AddInt32(&visits[i], 1)
	})

	for i, n := range visits {
		if n != 1 {
			t.Fatalf("account %d visited %d times, want 1", i, n)
		}
	}
}

// The whole point of the pool: a big account list must never put more than
// the bound in flight at AWS at once.
func TestForEachAccountBoundsConcurrency(t *testing.T) {
	const workers = 4
	var inFlight, peak int32

	forEachAccount(testAccounts(40), workers, func(int, *config.Account) {
		now := atomic.AddInt32(&inFlight, 1)
		for {
			old := atomic.LoadInt32(&peak)
			if now <= old || atomic.CompareAndSwapInt32(&peak, old, now) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		atomic.AddInt32(&inFlight, -1)
	})

	if peak > workers {
		t.Fatalf("peak concurrency %d exceeds bound %d", peak, workers)
	}
	if peak < 2 {
		t.Fatalf("peak concurrency %d: sweep ran serially", peak)
	}
}

func TestForEachAccountHandlesDegenerateInputs(t *testing.T) {
	called := false
	forEachAccount(nil, 8, func(int, *config.Account) { called = true })
	if called {
		t.Fatal("fn called for empty account list")
	}

	var visited int32
	forEachAccount(testAccounts(3), 0, func(int, *config.Account) { atomic.AddInt32(&visited, 1) })
	if visited != 3 {
		t.Fatalf("workers=0 visited %d accounts, want 3", visited)
	}
}

// /v1/models on an empty cache, the admin button and the timer can all fire
// together. They must share one pass over the accounts, not run three.
func TestSweepGroupJoinsConcurrentCallers(t *testing.T) {
	var g sweepGroup
	var runs int32
	release := make(chan struct{})
	started := make(chan struct{})

	go g.Do(func() {
		atomic.AddInt32(&runs, 1)
		close(started)
		<-release
	})
	<-started

	var joined sync.WaitGroup
	for range 5 {
		joined.Go(func() {
			g.Do(func() { atomic.AddInt32(&runs, 1) })
		})
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	joined.Wait()

	if runs != 1 {
		t.Fatalf("sweep ran %d times, want 1", runs)
	}

	g.Do(func() { atomic.AddInt32(&runs, 1) })
	if runs != 2 {
		t.Fatalf("sweep after the first finished ran %d times total, want 2", runs)
	}
}

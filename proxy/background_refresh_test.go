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

func TestSweepRefreshesTokensThatExpireBeforeTheNextSweep(t *testing.T) {
	const now int64 = 1_800_000_000
	for _, interval := range []time.Duration{5 * time.Minute, 30 * time.Minute} {
		every := int64(interval.Seconds())
		cases := []struct {
			name      string
			expiresAt int64
			want      bool
		}{
			{"no expiry", 0, false},
			{"already expired", now - 60, true},
			//! The 11:53 sweep left a token with 4.5 minutes; it then sat expired until 12:23.
			{"expires before the next sweep", now + 270, true},
			{"expires just after the next sweep, inside the skew", now + every + tokenRefreshSkewSeconds - 1, true},
			{"outlives the next sweep", now + every + tokenRefreshSkewSeconds + 1, false},
		}
		for _, c := range cases {
			acc := &config.Account{ExpiresAt: c.expiresAt}
			if got := tokenExpiresBeforeNextSweep(acc, now, interval); got != c.want {
				t.Errorf("every %s, %s: got %v, want %v", interval, c.name, got, c.want)
			}
		}
	}
}

func TestUsageInfoFreshUsesHalfInterval(t *testing.T) {
	const now int64 = 1_800_000_000
	cases := []struct {
		name        string
		lastRefresh int64
		every       time.Duration
		want        bool
	}{
		{"never refreshed", 0, 30 * time.Minute, false},
		{"refreshed by hand a minute ago", now - 60, 30 * time.Minute, true},
		{"just under half the interval", now - 899, 30 * time.Minute, true},
		{"half the interval", now - 900, 30 * time.Minute, false},
		//! The old full-interval cut-off skipped this one: the previous sweep's refresh
		//! landed seconds after that sweep began, so it was just under 30 minutes old.
		{"refreshed by the previous sweep", now - 1790, 30 * time.Minute, false},
		{"5-minute interval, 2 minutes ago", now - 120, 5 * time.Minute, true},
		{"5-minute interval, previous sweep", now - 290, 5 * time.Minute, false},
	}
	for _, c := range cases {
		if got := usageInfoFresh(c.lastRefresh, now, c.every); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestModelsListDueKeepsThirtyMinuteFloor(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	cases := []struct {
		name        string
		lastAttempt time.Time
		cachedAt    int64
		want        bool
	}{
		{"never listed", time.Time{}, 0, true},
		{"listed 5 minutes ago", now.Add(-5 * time.Minute), now.Add(-5 * time.Minute).Unix(), false},
		{"attempt failed 5 minutes ago, cache empty", now.Add(-5 * time.Minute), 0, false},
		{"/v1/models filled the cache 10 minutes ago", time.Time{}, now.Add(-10 * time.Minute).Unix(), false},
		{"both 30 minutes old", now.Add(-30 * time.Minute), now.Add(-30 * time.Minute).Unix(), true},
		{"attempt old, cache recent", now.Add(-time.Hour), now.Add(-time.Minute).Unix(), false},
	}
	for _, c := range cases {
		if got := modelsListDue(now, c.lastAttempt, c.cachedAt); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

package proxy

import (
	"sync"
	"time"

	"kiro-proxy/config"
)

// usageRefreshStartDelay is how long after start the first housekeeping sweep
// waits, so it does not compete with the listener coming up.
const usageRefreshStartDelay = 10 * time.Second

// modelsRefreshFloor is the least time between two models listings from the
// housekeeping sweep, however short the usage interval is.
const modelsRefreshFloor = 30 * time.Minute

// tokenExpiresBeforeNextSweep reports whether the account's access token runs
// out (within the usual skew) before the next sweep, which starts `every` after this one.
func tokenExpiresBeforeNextSweep(account *config.Account, now int64, every time.Duration) bool {
	//! Refreshing only tokens already inside the skew left a token with minutes to spare expired
	//! until the next sweep, so the admin saw "Token expired" on idle accounts for up to half an hour.
	if account.ExpiresAt == 0 {
		return false
	}
	return now > account.ExpiresAt-tokenRefreshSkewSeconds-int64(every.Seconds())
}

// usageInfoFresh reports whether an account's usage was refreshed recently
// enough for this sweep to skip it: within half the interval, so an account
// refreshed by hand just before the sweep is not asked again.
func usageInfoFresh(lastRefresh, now int64, every time.Duration) bool {
	//! The old cut-off was the full interval. An account's LastRefresh lands a few
	//! seconds after its sweep starts, so at the next sweep it was always just under
	//! one interval old: every second sweep skipped every account and usage really
	//! refreshed once an hour.
	return lastRefresh > 0 && now-lastRefresh < int64(every.Seconds())/2
}

// backgroundRefreshWorkers bounds how many accounts one housekeeping sweep
// talks to upstream at once. A serial sweep over hundreds of accounts outlasts
// its own interval; an unbounded one fires every account at AWS in the
// same second.
const backgroundRefreshWorkers = 8

// forEachAccount runs fn over accounts with at most workers calls in flight.
// fn gets the index so each call can write to a result slot it owns; merging
// those slots afterwards in account order keeps the outcome independent of
// which worker finished first.
func forEachAccount(accounts []config.Account, workers int, fn func(i int, account *config.Account)) {
	if len(accounts) == 0 {
		return
	}
	workers = max(1, min(workers, len(accounts)))

	next := make(chan int)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for i := range next {
				fn(i, &accounts[i])
			}
		})
	}
	for i := range accounts {
		next <- i
	}
	close(next)
	wg.Wait()
}

// sweepGroup collapses overlapping sweeps into one. A caller that arrives
// while a sweep runs waits for that sweep instead of starting a second pass
// over every account. The zero value is ready to use.
type sweepGroup struct {
	mu      sync.Mutex
	running chan struct{}
}

func (g *sweepGroup) Do(fn func()) {
	g.mu.Lock()
	if done := g.running; done != nil {
		g.mu.Unlock()
		<-done
		return
	}
	done := make(chan struct{})
	g.running = done
	g.mu.Unlock()

	defer func() {
		g.mu.Lock()
		g.running = nil
		g.mu.Unlock()
		close(done)
	}()
	fn()
}

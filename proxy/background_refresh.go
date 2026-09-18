package proxy

import (
	"kiro-proxy/config"
	"sync"
)

// backgroundRefreshWorkers bounds how many accounts one housekeeping sweep
// talks to upstream at once. A serial sweep over hundreds of accounts outlasts
// its own 30-minute tick; an unbounded one fires every account at AWS in the
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

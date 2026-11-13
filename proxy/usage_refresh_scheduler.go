package proxy

import (
	"time"

	"kiro-proxy/logger"
	"kiro-proxy/textfmt"
)

// refreshScheduler runs the background housekeeping sweep on an interval the
// admin can change while the proxy runs. The interval is read again on every
// wake, so a change takes effect at once: the next sweep is re-armed, stopped
// (0 means off) or, when the new interval says it is already overdue, run now.
type refreshScheduler struct {
	// interval returns the current interval; 0 means off.
	interval func() time.Duration
	// wake has room for one poke, so a change made while a sweep runs is kept
	// and applied once the sweep ends.
	wake chan struct{}
}

func newRefreshScheduler(interval func() time.Duration) *refreshScheduler {
	return &refreshScheduler{interval: interval, wake: make(chan struct{}, 1)}
}

// Reschedule tells the running loop to read the interval again. It never
// blocks, and a handler built without a scheduler (as tests do) ignores it.
func (s *refreshScheduler) Reschedule() {
	if s == nil {
		return
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// run sweeps until stop is closed. The first sweep is due startDelay after run
// starts; each later one is due one interval after the previous sweep ended, so
// a sweep that outlasts the interval is never followed by another straight away.
// Sweeps run on this goroutine, one at a time; sweep gets the interval in force.
func (s *refreshScheduler) run(stop <-chan struct{}, startDelay time.Duration, sweep func(every time.Duration)) {
	firstDue := time.Now().Add(startDelay)
	var lastEnd time.Time // zero until the first sweep ends

	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()

	announced := time.Duration(-1)
	for {
		every := s.interval()
		if every != announced {
			s.announce(announced, every)
			announced = every
		}

		if every <= 0 {
			select {
			case <-s.wake:
				continue
			case <-stop:
				return
			}
		}

		due := firstDue
		if !lastEnd.IsZero() {
			due = lastEnd.Add(every)
		}
		wait := time.Until(due)
		if wait <= 0 {
			sweep(every)
			lastEnd = time.Now()
			continue
		}

		//! Since Go 1.23 Reset and Stop leave no stale tick in timer.C, so the
		//! timer is reused without draining it.
		timer.Reset(wait)
		select {
		case <-timer.C:
			// Loop round: the interval is read again before sweeping, so a value
			// changed without a poke (a config restore) is still honoured.
		case <-s.wake:
			timer.Stop()
		case <-stop:
			return
		}
	}
}

func (s *refreshScheduler) announce(previous, every time.Duration) {
	switch {
	case every <= 0:
		logger.Infof("[BackgroundRefresh] Off: usage and tokens refresh only on demand")
	case previous < 0:
		logger.Infof("[BackgroundRefresh] Sweep every %s", textfmt.Duration(every))
	default:
		logger.Infof("[BackgroundRefresh] Interval set to %s", textfmt.Duration(every))
	}
}

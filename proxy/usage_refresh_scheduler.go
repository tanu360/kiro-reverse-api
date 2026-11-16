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
	// now is the clock sweeps are due by: wallNow, or a fake one in tests.
	now func() time.Time
}

func newRefreshScheduler(interval func() time.Duration) *refreshScheduler {
	return &refreshScheduler{interval: interval, wake: make(chan struct{}, 1), now: wallNow}
}

// wallCheckEvery is the longest a sweep loop waits before it reads the wall clock again.
//
// Go's timers run on the monotonic clock, which stops while the computer sleeps (macOS and
// Linux). A 30-minute timer armed before a 3-hour sleep still had most of its 30 minutes to go
// after waking, so every token showed "Token expired" until then. Waiting a minute at a time
// and judging "due" by the wall clock runs a sweep that fell due in the sleep within a minute.
const wallCheckEvery = time.Minute

// wallNow is the wall clock without its monotonic reading, so the difference between two of its
// values includes time the computer slept.
func wallNow() time.Time { return time.Now().Round(0) }

// waitUntil is how long a loop on the clock now waits before it looks again for due: until due,
// and a minute at most.
func waitUntil(now func() time.Time, due time.Time) time.Duration {
	return max(0, min(due.Sub(now()), wallCheckEvery))
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
	firstDue := s.now().Add(startDelay)
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

		now := s.now()
		if lastEnd.After(now) {
			// The clock was set back past the last sweep: count the interval from now, so the
			// next sweep is at most one interval away.
			lastEnd = now
		}
		due := firstDue
		if !lastEnd.IsZero() {
			due = lastEnd.Add(every)
		}
		if !now.Before(due) {
			sweep(every)
			lastEnd = s.now()
			continue
		}

		//! Since Go 1.23 Reset and Stop leave no stale tick in timer.C, so the
		//! timer is reused without draining it.
		timer.Reset(waitUntil(s.now, due))
		select {
		case <-timer.C:
			// Loop round: the clock and the interval are read again before sweeping,
			// so a value changed without a poke (a config restore) is still honoured.
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

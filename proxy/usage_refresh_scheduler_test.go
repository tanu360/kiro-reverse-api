package proxy

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"kiro-proxy/textfmt"
)

// The scheduler tests run in a synctest bubble: time.Sleep and the scheduler's
// timer use a fake clock that jumps forward once every goroutine is blocked, so
// a day of sweeps takes microseconds and every timestamp is exact.

const testStartDelay = 10 * time.Second

// schedulerRig runs a refreshScheduler over a settable interval and records
// every sweep. Use it only inside a synctest bubble.
type schedulerRig struct {
	t        *testing.T
	s        *refreshScheduler
	start    time.Time
	interval atomic.Int64
	// sweepTakes is how long each sweep lasts on the fake clock.
	sweepTakes time.Duration

	mu       sync.Mutex
	starts   []time.Duration // sweep start, relative to start
	everys   []time.Duration
	inFlight int
	overlap  bool

	stop chan struct{}
	done chan struct{}
}

func startSchedulerRig(t *testing.T, interval, sweepTakes time.Duration) *schedulerRig {
	t.Helper()
	r := &schedulerRig{t: t, start: time.Now(), sweepTakes: sweepTakes, stop: make(chan struct{}), done: make(chan struct{})}
	r.interval.Store(int64(interval))
	r.s = newRefreshScheduler(func() time.Duration { return time.Duration(r.interval.Load()) })
	go func() {
		defer close(r.done)
		r.s.run(r.stop, testStartDelay, r.sweep)
	}()
	synctest.Wait()
	return r
}

func (r *schedulerRig) sweep(every time.Duration) {
	r.mu.Lock()
	r.starts = append(r.starts, time.Since(r.start))
	r.everys = append(r.everys, every)
	r.inFlight++
	if r.inFlight > 1 {
		r.overlap = true
	}
	r.mu.Unlock()

	time.Sleep(r.sweepTakes)

	r.mu.Lock()
	r.inFlight--
	r.mu.Unlock()
}

// set changes the stored interval; poke also tells the scheduler, as a save does.
func (r *schedulerRig) set(interval time.Duration, poke bool) {
	r.interval.Store(int64(interval))
	if poke {
		r.s.Reschedule()
	}
	synctest.Wait()
}

// at advances the fake clock to offset after start and lets the scheduler settle.
func (r *schedulerRig) at(offset time.Duration) {
	r.t.Helper()
	wait := offset - time.Since(r.start)
	if wait < 0 {
		r.t.Fatalf("at(%s): the clock is already at %s", offset, time.Since(r.start))
	}
	time.Sleep(wait)
	synctest.Wait()
}

// sweptAt fails unless the sweeps so far started exactly at offsets.
func (r *schedulerRig) sweptAt(offsets ...time.Duration) {
	r.t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.starts) != len(offsets) {
		r.t.Fatalf("at %s: %d sweeps at %v, want %v", time.Since(r.start), len(r.starts), r.starts, offsets)
	}
	for i := range offsets {
		if r.starts[i] != offsets[i] {
			r.t.Fatalf("at %s: sweeps at %v, want %v", time.Since(r.start), r.starts, offsets)
		}
	}
}

// everyOf returns the interval sweep i was given.
func (r *schedulerRig) everyOf(i int) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.everys[i]
}

func (r *schedulerRig) close() {
	close(r.stop)
	<-r.done
}

func TestRefreshSchedulerFirstSweepAfterStartDelay(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second - time.Nanosecond)
		r.sweptAt()
		r.at(10 * time.Second)
		r.sweptAt(10 * time.Second)
		if got := r.everyOf(0); got != 30*time.Minute {
			t.Fatalf("sweep got interval %s, want 30m", got)
		}
	})
}

func TestRefreshSchedulerSweepsEveryInterval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 90*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+30*time.Minute, 10*time.Second+60*time.Minute, 10*time.Second+90*time.Minute)
	})
}

func TestRefreshSchedulerShorterIntervalSweepsWhenOverdue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 20*time.Minute)
		r.set(5*time.Minute, true)
		// The last sweep was 20 minutes ago: overdue under 5 minutes, so it runs now.
		r.sweptAt(10*time.Second, 10*time.Second+20*time.Minute)

		r.at(10*time.Second + 30*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+20*time.Minute, 10*time.Second+25*time.Minute, 10*time.Second+30*time.Minute)
		if got := r.everyOf(1); got != 5*time.Minute {
			t.Fatalf("sweep after the change got %s, want 5m", got)
		}
	})
}

func TestRefreshSchedulerShorterIntervalNotYetDueReArms(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 2*time.Minute)
		r.set(5*time.Minute, true)
		r.sweptAt(10 * time.Second)

		r.at(10*time.Second + 5*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+5*time.Minute)
	})
}

func TestRefreshSchedulerLongerIntervalDefersNextSweep(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 5*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + time.Minute)
		r.set(60*time.Minute, true)

		r.at(10*time.Second + 59*time.Minute)
		r.sweptAt(10 * time.Second)
		r.at(10*time.Second + 60*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+60*time.Minute)
	})
}

func TestRefreshSchedulerOffStopsSweeps(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 5*time.Minute)
		r.set(0, true)

		r.at(24 * time.Hour)
		r.sweptAt(10 * time.Second)
	})
}

func TestRefreshSchedulerOnAgainSweepsAtOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 5*time.Minute)
		r.set(0, true)
		r.at(2 * time.Hour)
		r.set(30*time.Minute, true)
		// Off for longer than the interval: the sweep it missed runs now.
		r.sweptAt(10*time.Second, 2*time.Hour)

		r.at(2*time.Hour + 30*time.Minute)
		r.sweptAt(10*time.Second, 2*time.Hour, 2*time.Hour+30*time.Minute)
	})
}

func TestRefreshSchedulerOnAgainKeepsScheduleWhenNotDue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 5*time.Minute)
		r.set(0, true)
		r.at(10*time.Second + 10*time.Minute)
		r.set(30*time.Minute, true)
		r.sweptAt(10 * time.Second)

		r.at(10*time.Second + 30*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+30*time.Minute)
	})
}

func TestRefreshSchedulerStartsOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 0, 0)
		defer r.close()

		r.at(time.Hour)
		r.sweptAt()

		r.set(15*time.Minute, true)
		// Never swept, so turning it on sweeps at once.
		r.sweptAt(time.Hour)
		r.at(time.Hour + 15*time.Minute)
		r.sweptAt(time.Hour, time.Hour+15*time.Minute)
	})
}

func TestRefreshSchedulerTurnedOnBeforeStartDelayWaitsForIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 0, 0)
		defer r.close()

		r.at(3 * time.Second)
		r.set(30*time.Minute, true)
		r.sweptAt()
		r.at(10 * time.Second)
		r.sweptAt(10 * time.Second)
	})
}

// A value changed without a poke, as a config restore does, is read when the
// armed timer fires instead of sweeping on the old schedule.
func TestRefreshSchedulerTimerWakeRereadsInterval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 5*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + time.Minute)
		r.set(60*time.Minute, false)
		r.at(10*time.Second + 5*time.Minute)
		r.sweptAt(10 * time.Second)
		r.at(10*time.Second + 60*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+60*time.Minute)

		r.set(0, false)
		r.at(10*time.Second + 3*time.Hour)
		r.sweptAt(10*time.Second, 10*time.Second+60*time.Minute)
	})
}

func TestRefreshSchedulerChangeDuringSweepNoOverlap(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 5*time.Minute, 2*time.Minute)
		defer r.close()

		// Mid-sweep: the poke waits in the channel until the sweep ends.
		r.at(10*time.Second + time.Minute)
		r.set(10*time.Minute, true)
		r.set(10*time.Minute, true) // a second poke while one is queued must not block
		r.sweptAt(10 * time.Second)

		// The next sweep is due 10 minutes after the first one ended (at 2m10s).
		r.at(10*time.Second + 12*time.Minute - time.Nanosecond)
		r.sweptAt(10 * time.Second)
		r.at(10*time.Second + 12*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+12*time.Minute)

		r.mu.Lock()
		defer r.mu.Unlock()
		if r.overlap {
			t.Fatal("two sweeps ran at once")
		}
	})
}

// A sweep that outlasts the interval is followed by a full interval, not by
// another sweep straight away.
func TestRefreshSchedulerLongSweepWaitsFullIntervalAfterIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 5*time.Minute, 7*time.Minute)
		defer r.close()

		r.at(10*time.Second + 25*time.Minute)
		r.sweptAt(10*time.Second, 10*time.Second+12*time.Minute, 10*time.Second+24*time.Minute)
	})
}

func TestRefreshSchedulerReturnsOnStop(t *testing.T) {
	for _, interval := range []time.Duration{30 * time.Minute, 0} {
		synctest.Test(t, func(t *testing.T) {
			r := startSchedulerRig(t, interval, 0)
			r.at(10*time.Second + time.Minute)
			close(r.stop)
			synctest.Wait()
			select {
			case <-r.done:
			default:
				t.Fatalf("interval %s: run did not return after stop", interval)
			}
		})
	}
}

func TestRefreshSchedulerRescheduleNilSafe(t *testing.T) {
	var none *refreshScheduler
	none.Reschedule()

	live := newRefreshScheduler(func() time.Duration { return 0 })
	live.Reschedule()
	live.Reschedule() // the channel holds one poke; a second must not block
	if len(live.wake) != 1 {
		t.Fatalf("wake holds %d pokes, want 1", len(live.wake))
	}
}

func TestRefreshSchedulerLogsIntervalChanges(t *testing.T) {
	logs := captureLogs(t)
	synctest.Test(t, func(t *testing.T) {
		r := startSchedulerRig(t, 30*time.Minute, 0)
		defer r.close()
		r.at(time.Minute)
		r.set(5*time.Minute, true)
		r.set(5*time.Minute, true) // unchanged: no second line
		r.set(0, true)
		r.set(90*time.Minute, true)
	})
	out := logs.String()
	for _, want := range []string{
		"[BackgroundRefresh] Sweep every 30m",
		"[BackgroundRefresh] Interval set to 5m",
		"[BackgroundRefresh] Off: usage and tokens refresh only on demand",
		"[BackgroundRefresh] Interval set to 1h 30m",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in logs:\n%s", want, out)
		}
	}
	if n := strings.Count(out, "Interval set to 5m"); n != 1 {
		t.Errorf("logged the 5m change %d times, want 1:\n%s", n, out)
	}
}

// housekeepingRig runs runHousekeepingJobs over a settable usage interval and
// records when each job starts. Use it only inside a synctest bubble.
type housekeepingRig struct {
	t        *testing.T
	start    time.Time
	interval atomic.Int64
	usage    *refreshScheduler
	takes    time.Duration // how long each job lasts on the fake clock

	mu       sync.Mutex
	listings []time.Duration
	sweeps   []time.Duration
	inFlight int
	overlap  bool
	// listFails holds whether each listing, in order, asks for a retry; later ones do not.
	listFails []bool

	stop chan struct{}
	done chan struct{}
}

func startHousekeepingRig(t *testing.T, interval, takes time.Duration, listFails ...bool) *housekeepingRig {
	t.Helper()
	r := &housekeepingRig{t: t, start: time.Now(), takes: takes, listFails: listFails, stop: make(chan struct{}), done: make(chan struct{})}
	r.interval.Store(int64(interval))
	r.usage = newRefreshScheduler(func() time.Duration { return time.Duration(r.interval.Load()) })
	go func() {
		defer close(r.done)
		runHousekeepingJobs(r.stop, r.usage,
			func() bool {
				r.job(&r.listings)
				r.mu.Lock()
				defer r.mu.Unlock()
				n := len(r.listings) - 1
				return n < len(r.listFails) && r.listFails[n]
			},
			func(time.Duration) { r.job(&r.sweeps) })
	}()
	synctest.Wait()
	return r
}

func (r *housekeepingRig) job(starts *[]time.Duration) {
	r.mu.Lock()
	*starts = append(*starts, time.Since(r.start))
	r.inFlight++
	if r.inFlight > 1 {
		r.overlap = true
	}
	r.mu.Unlock()

	time.Sleep(r.takes)

	r.mu.Lock()
	r.inFlight--
	r.mu.Unlock()
}

func (r *housekeepingRig) set(interval time.Duration) {
	r.interval.Store(int64(interval))
	r.usage.Reschedule()
	synctest.Wait()
}

func (r *housekeepingRig) at(offset time.Duration) {
	r.t.Helper()
	time.Sleep(offset - time.Since(r.start))
	synctest.Wait()
}

func (r *housekeepingRig) counts() (listings, sweeps int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.listings), len(r.sweeps)
}

func (r *housekeepingRig) close() {
	close(r.stop)
	<-r.done
}

func TestHousekeepingListsModelsWhileUsageSweepIsOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startHousekeepingRig(t, 0, 0)
		defer r.close()

		r.at(10 * time.Second)
		if l, s := r.counts(); l != 1 || s != 0 {
			t.Fatalf("at boot: %d listings, %d sweeps; want the boot listing and no sweep", l, s)
		}
		r.at(10*time.Second + 2*time.Hour)
		if l, s := r.counts(); l != 5 || s != 0 {
			t.Fatalf("after 2h off: %d listings, %d sweeps; want 5 listings, no sweep", l, s)
		}
	})
}

func TestHousekeepingListsModelsEveryThirtyMinutesWhateverTheInterval(t *testing.T) {
	for _, interval := range []time.Duration{5 * time.Minute, 30 * time.Minute, 24 * time.Hour} {
		t.Run(textfmt.Duration(interval), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				r := startHousekeepingRig(t, interval, 0)
				defer r.close()

				r.at(10*time.Second + 2*time.Hour)
				r.mu.Lock()
				defer r.mu.Unlock()
				want := []time.Duration{10 * time.Second}
				for i := 1; i <= 4; i++ {
					want = append(want, 10*time.Second+time.Duration(i)*modelsListEvery)
				}
				if len(r.listings) != len(want) {
					t.Fatalf("listings at %v, want %v", r.listings, want)
				}
				for i := range want {
					if r.listings[i] != want[i] {
						t.Fatalf("listings at %v, want %v", r.listings, want)
					}
				}
				if wantSweeps := 1 + int(2*time.Hour/interval); len(r.sweeps) != wantSweeps {
					t.Fatalf("%d usage sweeps, want %d", len(r.sweeps), wantSweeps)
				}
			})
		})
	}
}

func TestHousekeepingIntervalChangeLeavesModelsListingAlone(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := startHousekeepingRig(t, 30*time.Minute, 0)
		defer r.close()

		r.at(10*time.Second + 5*time.Minute)
		r.set(0)
		r.set(5 * time.Minute) // overdue: sweeps at once
		r.set(0)
		r.at(10*time.Second + 30*time.Minute)
		if l, s := r.counts(); l != 2 || s != 2 {
			t.Fatalf("%d listings, %d sweeps; want 2 listings (boot, +30m) and 2 sweeps (boot, on again)", l, s)
		}
	})
}

func TestHousekeepingJobsNeverOverlap(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Both jobs are due at boot, and each lasts a minute.
		r := startHousekeepingRig(t, 5*time.Minute, time.Minute)
		defer r.close()

		r.at(10*time.Second + 2*time.Hour)
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.overlap {
			t.Fatal("the models listing and the usage sweep ran at the same time")
		}
		if len(r.listings) < 4 || len(r.sweeps) < 15 {
			t.Fatalf("%d listings, %d sweeps; both jobs should keep running", len(r.listings), len(r.sweeps))
		}
	})
}

func TestHousekeepingJobWaitingForItsTurnGivesUpOnStop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Both jobs are due at boot and each lasts an hour, so one waits.
		r := startHousekeepingRig(t, 5*time.Minute, time.Hour)

		r.at(20 * time.Second)
		if l, s := r.counts(); l+s != 1 {
			t.Fatalf("%d listings, %d sweeps after boot; want exactly one job running", l, s)
		}
		r.close()
		if l, s := r.counts(); l+s != 1 {
			t.Fatalf("%d listings, %d sweeps after stop; the waiting job must not start", l, s)
		}
	})
}

func TestHousekeepingRetriesAFailedModelsListingSooner(t *testing.T) {
	boot := 10 * time.Second
	for _, tc := range []struct {
		name  string
		fails []bool
		want  []time.Duration
	}{
		{"recovers on the 2nd retry", []bool{true, true, false},
			[]time.Duration{boot, boot + time.Minute, boot + 3*time.Minute, boot + 3*time.Minute + modelsListEvery}},
		{"keeps failing: 4 retries, then the regular cadence", []bool{true, true, true, true, true, true, true},
			[]time.Duration{boot, boot + time.Minute, boot + 3*time.Minute, boot + 7*time.Minute, boot + 15*time.Minute,
				boot + 15*time.Minute + modelsListEvery, boot + 15*time.Minute + 2*modelsListEvery}},
		{"a later failure gets the retries again", []bool{false, true, false},
			[]time.Duration{boot, boot + modelsListEvery, boot + modelsListEvery + time.Minute, boot + 2*modelsListEvery + time.Minute}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				r := startHousekeepingRig(t, 5*time.Minute, 0, tc.fails...)
				defer r.close()

				r.at(tc.want[len(tc.want)-1] + time.Second)
				r.mu.Lock()
				defer r.mu.Unlock()
				if len(r.listings) != len(tc.want) {
					t.Fatalf("listings at %v, want %v", r.listings, tc.want)
				}
				for i := range tc.want {
					if r.listings[i] != tc.want[i] {
						t.Fatalf("listings at %v, want %v", r.listings, tc.want)
					}
				}
			})
		})
	}
}

func TestHousekeepingModelsRetryWaitsForTheUsageSweep(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Every job lasts 90 s, longer than the first retry delay, and every listing fails.
		r := startHousekeepingRig(t, 5*time.Minute, 90*time.Second, true, true, true, true)
		defer r.close()

		r.at(10*time.Second + time.Hour)
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.overlap {
			t.Fatal("a models retry ran at the same time as the usage sweep")
		}
		if len(r.listings) < 5 {
			t.Fatalf("%d listings, want the boot listing and its 4 retries", len(r.listings))
		}
	})
}

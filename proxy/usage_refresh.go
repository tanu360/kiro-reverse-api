package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"kiro-proxy/config"
)

// codeUsageRefreshIntervalRange: usageRefreshIntervalMinutes is neither 0 nor 5..1440.
const codeUsageRefreshIntervalRange = "usage_refresh_interval_range"

// validateUsageRefreshInterval writes a 400 and returns false when a settings
// patch carries an interval the setting does not accept. A missing field passes.
func validateUsageRefreshInterval(w http.ResponseWriter, minutes *int) bool {
	if minutes == nil || config.ValidUsageRefreshIntervalMinutes(*minutes) {
		return true
	}
	writeAdminError(w, http.StatusBadRequest, codeUsageRefreshIntervalRange,
		fmt.Sprintf("usageRefreshIntervalMinutes must be 0 (off) or between %d and %d",
			config.MinUsageRefreshIntervalMinutes, config.MaxUsageRefreshIntervalMinutes))
	return false
}

// applyUsageRefreshInterval saves a validated interval and tells the running
// sweep loop, which re-arms, stops or sweeps at once. It writes a 500 and
// returns false when the save fails. A missing field changes nothing.
func (h *Handler) applyUsageRefreshInterval(w http.ResponseWriter, minutes *int) bool {
	if minutes == nil {
		return true
	}
	if err := config.UpdateUsageRefreshIntervalMinutes(*minutes); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return false
	}
	h.usageRefresh.Reschedule()
	return true
}

// runHousekeeping runs the background jobs until stop is closed: the models
// listing on its fixed cadence and the usage sweep on the admin's interval.
func (h *Handler) runHousekeeping(stop <-chan struct{}) {
	go h.rescheduleOnConfigEvents(stop)
	runHousekeepingJobs(stop, h.usageRefresh, h.refreshModelsCache, h.refreshAllAccounts)
}

// runHousekeepingJobs lists models usageRefreshStartDelay after start and then
// every modelsListEvery, beside the usage scheduler, until stop is closed. The
// two jobs take turns, so they never talk to upstream at the same time (both
// are due together at boot), as when they ran in one loop.
func runHousekeepingJobs(stop <-chan struct{}, usage *refreshScheduler, listModels func(), refreshUsage func(every time.Duration)) {
	//! The models listing must not follow the usage interval. It is what calls
	//! pool.SetModelList, and an account with no list is treated as offering every
	//! model, so with the sweep Off a restart left free accounts picked for Pro-only
	//! models. A long interval also kept an upgraded account's old list for hours.
	//
	// A one-slot channel rather than a sync.Mutex: a job waiting for its turn
	// gives up when stop closes, and synctest counts a goroutine blocked on a
	// channel (unlike one blocked on a mutex) as idle, so the fake clock moves.
	turn := make(chan struct{}, 1)
	inTurn := func(job func()) {
		select {
		case turn <- struct{}{}:
		case <-stop:
			return
		}
		defer func() { <-turn }()
		job()
	}

	listed := make(chan struct{})
	go func() {
		defer close(listed)
		runEvery(stop, usageRefreshStartDelay, modelsListEvery, func() { inTurn(listModels) })
	}()
	usage.run(stop, usageRefreshStartDelay, func(every time.Duration) {
		inTurn(func() { refreshUsage(every) })
	})
	<-listed
}

// runEvery calls job startDelay after it starts, then every `every` after the
// previous call ended, until stop is closed.
func runEvery(stop <-chan struct{}, startDelay, every time.Duration, job func()) {
	timer := time.NewTimer(startDelay)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			job()
			timer.Reset(every)
		case <-stop:
			return
		}
	}
}

// rescheduleOnConfigEvents pokes the sweep loop whenever the stored interval
// may have changed: a settings save, or a backup restore, which replaces the
// whole config without going through the settings API. Without it a restore
// that turns the sweep back on would wait for the next settings change.
func (h *Handler) rescheduleOnConfigEvents(stop <-chan struct{}) {
	b := getBroadcaster()
	id, events := b.Subscribe()
	defer b.Unsubscribe(id)
	for {
		select {
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == eventSettingsChanged || evt.Type == eventBackupRestored {
				h.usageRefresh.Reschedule()
			}
		case <-stop:
			return
		}
	}
}

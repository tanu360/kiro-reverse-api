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

// housekeepingSweep returns the sweep the scheduler runs: the models list, then
// every account's usage and tokens.
func (h *Handler) housekeepingSweep() func(every time.Duration) {
	var modelsListedAt time.Time
	return func(every time.Duration) {
		h.modelsCacheMu.RLock()
		cachedAt := h.modelsCacheTime
		h.modelsCacheMu.RUnlock()
		if now := time.Now(); modelsListDue(now, modelsListedAt, cachedAt) {
			modelsListedAt = now
			h.refreshModelsCache()
		}
		h.refreshAllAccounts(every)
	}
}

// modelsListDue reports whether a sweep should list models again. The list
// rarely changes, so a 5-minute usage interval must not list models every 5
// minutes: it is listed when both the last attempt and the cached list (which
// /v1/models and the admin page also fill) are at least modelsRefreshFloor old.
func modelsListDue(now, lastAttempt time.Time, cachedAt int64) bool {
	if !lastAttempt.IsZero() && now.Sub(lastAttempt) < modelsRefreshFloor {
		return false
	}
	return now.Unix()-cachedAt >= int64(modelsRefreshFloor.Seconds())
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

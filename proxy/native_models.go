package proxy

import (
	"strings"
	"sync/atomic"
	"time"

	"kiro-proxy/logger"
)

//! A substring mapping rule such as "gpt-5" also matches models Kiro serves itself
//! (gpt-5.6-sol on Pro accounts) and sent them to a different model. A name Kiro
//! lists now passes through before the substring rules run; only an exact rule
//! redirects it. The set mirrors the /v1/models cache, so it is empty until the
//! first sweep, and the old substring behaviour applies until then.

// nativeModelIDs maps each lower-cased model ID in the /v1/models cache to its listed spelling.
var nativeModelIDs atomic.Pointer[map[string]string]

// publishNativeModels replaces the native model set. It is called wherever h.cachedModels is written.
func publishNativeModels(models []ModelInfo) {
	if len(models) == 0 {
		nativeModelIDs.Store(nil)
		return
	}
	ids := make(map[string]string, len(models))
	for _, m := range models {
		id := strings.TrimSpace(m.ModelId)
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, exists := ids[key]; !exists {
			ids[key] = id
		}
	}
	nativeModelIDs.Store(&ids)
}

// nativeModelID reports the listed spelling of model when Kiro lists it (trimmed, case-insensitive).
func nativeModelID(model string) (string, bool) {
	ids := nativeModelIDs.Load()
	if ids == nil {
		return "", false
	}
	key := strings.ToLower(strings.TrimSpace(model))
	if key == "" {
		return "", false
	}
	id, ok := (*ids)[key]
	return id, ok
}

// modelsCacheRetryDelays spaces the retries after a boot sweep that cached no models.
// They add up to 15 minutes, half the regular sweep interval.
var modelsCacheRetryDelays = []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute}

// retryEmptyModelsCache sweeps the models again, after each delay, while the cache is still empty.
func (h *Handler) retryEmptyModelsCache(delays []time.Duration) {
	//! The native set is filled only by a sweep. When the boot sweep fails for every account
	//! (token refresh or network down at start), substring rules would hijack native models
	//! until the 30-minute timer. Retrying sooner shortens that window to about a minute.
	for _, delay := range delays {
		if h.modelsCacheFilled() {
			return
		}
		logger.Infof("[ModelsCache] No models cached yet, retrying in %s", delay)
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-h.stopRefresh:
			timer.Stop()
			return
		}
		if !h.modelsCacheFilled() {
			h.refreshModelsCache()
		}
	}
}

func (h *Handler) modelsCacheFilled() bool {
	h.modelsCacheMu.RLock()
	defer h.modelsCacheMu.RUnlock()
	return len(h.cachedModels) > 0
}

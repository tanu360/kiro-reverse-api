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

// modelsListRetryDelays space the extra listings after one in which an enabled account
// failed. They add up to 15 minutes, half of modelsListEvery; a listing with no failure
// starts them over.
var modelsListRetryDelays = []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute}

// listModelsForHousekeeping runs one models sweep and reports whether an enabled account
// failed it, so the housekeeping loop lists again sooner than modelsListEvery.
func (h *Handler) listModelsForHousekeeping() (retry bool) {
	//! The native set is filled only by a sweep. An account that failed it (token refresh
	//! or network down at start) is missing its models, so substring rules would hijack
	//! the native models only it lists until the next regular sweep, 30 minutes away.
	h.refreshModelsCache()
	h.modelsCacheMu.RLock()
	defer h.modelsCacheMu.RUnlock()
	failed := 0
	for _, result := range h.lastModelsSweep {
		if !result.OK {
			failed++
		}
	}
	if failed > 0 {
		logger.Infof("[ModelsCache] %d of %d accounts could not list their models", failed, len(h.lastModelsSweep))
	}
	return failed > 0
}

// runModelsListing calls list startDelay after it starts, then every `every` after the
// previous call ended, until stop is closed. After a call that asks for a retry, the next
// of retries replaces `every`; once they are used up, `every` applies until a call that
// does not ask, which starts them over.
func runModelsListing(stop <-chan struct{}, startDelay, every time.Duration, retries []time.Duration, list func() (retry bool)) {
	timer := time.NewTimer(startDelay)
	defer timer.Stop()
	next := 0
	for {
		select {
		case <-timer.C:
			delay := every
			if !list() {
				next = 0
			} else if next < len(retries) {
				delay = retries[next]
				next++
				logger.Infof("[ModelsCache] Listing models again in %s", delay)
			}
			timer.Reset(delay)
		case <-stop:
			return
		}
	}
}

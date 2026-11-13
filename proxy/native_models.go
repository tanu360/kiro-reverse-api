package proxy

import (
	"strings"
	"sync/atomic"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/textfmt"
)

//! A substring mapping rule such as "gpt-5" also matches models Kiro serves itself
//! (gpt-5.6-sol on Pro accounts) and sent them to a different model. A name Kiro
//! lists now passes through before the substring rules run; only an exact rule
//! redirects it. The set mirrors the /v1/models cache. At start it holds the IDs the
//! last successful sweep saved, so a restart (about 10 s before the first sweep, or
//! longer when every account fails it) does not bring the substring behaviour back.
//! On a first start with no saved IDs, the old behaviour applies until the first sweep.

// nativeModelIDs maps each lower-cased model ID in the /v1/models cache to its listed spelling.
var nativeModelIDs atomic.Pointer[map[string]string]

// publishNativeModels replaces the native model set. It is called wherever h.cachedModels is written.
func publishNativeModels(models []ModelInfo) {
	if len(models) == 0 {
		nativeModelIDs.Store(nil)
		return
	}
	ids := make([]string, 0, len(models))
	for _, m := range models {
		ids = append(ids, m.ModelId)
	}
	set := nativeModelSet(ids)
	nativeModelIDs.Store(&set)
}

// nativeModelSet keys each non-blank ID by its trimmed lower-cased form; the first spelling wins.
func nativeModelSet(ids []string) map[string]string {
	set := make(map[string]string, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, exists := set[key]; !exists {
			set[key] = id
		}
	}
	return set
}

// restoreNativeModels publishes the IDs the last successful sweep saved, unless a sweep
// already published a set. NewHandler calls it before any request is served.
func restoreNativeModels() {
	ids, err := config.LoadNativeModelIDs()
	if err != nil {
		logger.Warnf("[ModelsCache] Could not load the saved model list: %v", err)
		return
	}
	set := nativeModelSet(ids)
	if len(set) == 0 {
		return
	}
	if nativeModelIDs.CompareAndSwap(nil, &set) {
		logger.Infof("[ModelsCache] Restored %s from the last listing", textfmt.Count(len(set), "native model", "native models"))
	}
}

// rememberNativeModels saves the model IDs a sweep cached, for restoreNativeModels. Sweeps
// are rare (the 30-minute timer, its retries, an admin refresh), so the one-row write
// needs no change check.
func rememberNativeModels(models []ModelInfo) {
	ids := make([]string, 0, len(models))
	for _, m := range models {
		if id := strings.TrimSpace(m.ModelId); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	if err := config.SaveNativeModelIDs(ids); err != nil {
		logger.Warnf("[ModelsCache] Could not save the model list: %v", err)
	}
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
		logger.Infof("[ModelsCache] %d of %s could not list their models", failed, textfmt.Count(len(h.lastModelsSweep), "account", "accounts"))
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
				logger.Infof("[ModelsCache] Listing models again in %s", textfmt.Duration(delay))
			}
			timer.Reset(delay)
		case <-stop:
			return
		}
	}
}

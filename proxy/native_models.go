package proxy

import (
	"strings"
	"sync/atomic"
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

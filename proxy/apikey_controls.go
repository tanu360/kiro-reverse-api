package proxy

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/textfmt"
)

// Client API key controls on the request path: expiry, the key's own
// requests-per-minute limit and its model allowlist. The account scope and the
// routing mode ride on the request context (auth.go) into the pool picks.

// apiKeyRPMWindow is the sliding window a key's RPM limit counts over.
const apiKeyRPMWindow = time.Minute

// apiKeyRPM remembers when each key started its recent requests, oldest first,
// as unix nanoseconds. Only keys with a limit are tracked, and at most limit
// starts each. It lives in memory: a restart starts every window clean.
type apiKeyRPMStarts struct {
	mu sync.Mutex
	m  map[string][]int64
}

var apiKeyRPM = &apiKeyRPMStarts{}

// take counts a request start for key id against limit at now. When the key
// already started limit requests in the last minute it counts nothing and
// returns how long until the oldest of them leaves the window.
func (r *apiKeyRPMStarts) take(id string, limit int, now time.Time) (time.Duration, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit <= 0 {
		delete(r.m, id)
		return 0, true
	}
	cutoff := now.Add(-apiKeyRPMWindow).UnixNano()
	starts := r.m[id]
	keep := 0
	for keep < len(starts) && starts[keep] <= cutoff {
		keep++
	}
	starts = starts[keep:]
	if len(starts) >= limit {
		//! A lowered limit only needs the newest starts; the oldest of those decides the wait.
		starts = starts[len(starts)-limit:]
		r.m[id] = starts
		return time.Unix(0, starts[0]).Add(apiKeyRPMWindow).Sub(now), false
	}
	if r.m == nil {
		r.m = make(map[string][]int64)
	}
	r.m[id] = append(append([]int64(nil), starts...), now.UnixNano())
	return 0, true
}

// forget drops a key's starts, for a deleted key or a reset.
func (r *apiKeyRPMStarts) forget(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m, id)
}

// takeApiKeyRPM counts one request against entry's RPM limit, or answers 429
// with when to retry. Only requests to the model endpoints count; a request
// counts when it passes auth, whatever happens to it later.
func takeApiKeyRPM(entry *config.ApiKeyEntry, now time.Time) error {
	if entry == nil || entry.RPMLimit <= 0 {
		if entry != nil {
			apiKeyRPM.forget(entry.ID)
		}
		return nil
	}
	wait, ok := apiKeyRPM.take(entry.ID, entry.RPMLimit, now)
	if ok {
		return nil
	}
	ae := newAuthError(http.StatusTooManyRequests, "rate_limit_error",
		fmt.Sprintf("API key rate limit reached: %s per minute", textfmt.Count(entry.RPMLimit, "request", "requests")))
	//! Rounded up so a client that waits the header's seconds is never refused again.
	ae.retryAfter = max(wait, time.Second)
	return ae
}

// apiKeyExpiredMessage is the 401 text for a key past its expiry time.
func apiKeyExpiredMessage(expiresAt int64) string {
	return "API key expired at " + time.Unix(expiresAt, 0).UTC().Format("2006-01-02 15:04 UTC")
}

// apiKeyModelRefusal is the 403 text for a request whose key may not call
// model (the model it resolved to), or "" when the key may.
func apiKeyModelRefusal(ctx context.Context, model string) string {
	v, ok := apiKeyFromContext(ctx)
	if !ok || len(v.allowedModels) == 0 {
		return ""
	}
	if config.ApiKeyAllowsModel(config.ApiKeyEntry{AllowedModels: v.allowedModels}, model) {
		return ""
	}
	return fmt.Sprintf("model %q is not allowed for this API key; it may use %s", model, strings.Join(v.allowedModels, ", "))
}

// apiKeyAllowsListedModel reports whether /v1/models shows a model id to the
// request's key: the id is resolved the way a request resolves it, and the
// result must be on the key's model list. A key without a list sees them all.
func apiKeyAllowsListedModel(ctx context.Context, id, thinkingSuffix string) bool {
	v, ok := apiKeyFromContext(ctx)
	if !ok || len(v.allowedModels) == 0 {
		return true
	}
	model, _ := ParseModelAndThinking(id, thinkingSuffix)
	return config.ApiKeyAllowsModel(config.ApiKeyEntry{AllowedModels: v.allowedModels}, model)
}

// apiKeyMatchesNoAccount reports whether the request's key is scoped to
// accounts and the scope holds none (its tags match no account and it lists
// no id), and the message that says so.
func apiKeyMatchesNoAccount(ctx context.Context) (string, bool) {
	v, ok := apiKeyFromContext(ctx)
	if !ok || v.allowed == nil || len(v.allowed) > 0 {
		return "", false
	}
	if len(v.accountTags) > 0 {
		return fmt.Sprintf("No account matches this API key's account tags (%s)", strings.Join(v.accountTags, ", ")), true
	}
	return "No account matches this API key's account scope", true
}

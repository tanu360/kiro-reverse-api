package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"kiro-proxy/config"
)

// Client API key access on the proxy side: the account allowlist a request
// carries, the model lists cut down to it, and regenerating a key.

// allowedAccountsFromContext is the request's account allowlist, taken from
// its API key at auth; nil means every account (no key, or an unbound one).
func allowedAccountsFromContext(ctx context.Context) map[string]bool {
	if ctx == nil {
		return nil
	}
	if v, ok := ctx.Value(apiKeyContextKey{}).(apiKeyContextValue); ok {
		return v.allowed
	}
	return nil
}

// apiKeyOffersModel reports whether a request with this allowlist could be
// routed for the listed model id: the id is resolved the way a request
// resolves it (thinking suffix, model mappings) and one allowed account must
// offer the result. "auto" is always offered, as /v1/models always lists it.
func (h *Handler) apiKeyOffersModel(allowed map[string]bool, id, thinkingSuffix string) bool {
	model, _ := ParseModelAndThinking(id, thinkingSuffix)
	if strings.EqualFold(strings.TrimSpace(model), "auto") {
		return true
	}
	return h.pool.AllowedOffersModel(allowed, model)
}

// filterModelMapsForAPIKey drops the /v1/models entries the request's bound
// accounts cannot serve. An unbound request gets the list unchanged.
func (h *Handler) filterModelMapsForAPIKey(ctx context.Context, models []map[string]interface{}, thinkingSuffix string) []map[string]interface{} {
	allowed := allowedAccountsFromContext(ctx)
	if allowed == nil || h.pool == nil {
		return models
	}
	out := make([]map[string]interface{}, 0, len(models))
	for _, m := range models {
		id, _ := m["id"].(string)
		if h.apiKeyOffersModel(allowed, id, thinkingSuffix) {
			out = append(out, m)
		}
	}
	return out
}

// filterModelInfosForAPIKey is filterModelMapsForAPIKey for the Codex manifest.
func (h *Handler) filterModelInfosForAPIKey(ctx context.Context, models []ModelInfo) []ModelInfo {
	allowed := allowedAccountsFromContext(ctx)
	if allowed == nil || h.pool == nil {
		return models
	}
	thinkingSuffix := config.GetThinkingConfig().Suffix
	out := make([]ModelInfo, 0, len(models))
	for _, m := range models {
		if h.apiKeyOffersModel(allowed, m.ModelId, thinkingSuffix) {
			out = append(out, m)
		}
	}
	return out
}

// apiRegenerateApiKey swaps the key's value for a fresh sk-... value and keeps
// everything else. The response carries the new value once, like a create.
func (h *Handler) apiRegenerateApiKey(w http.ResponseWriter, _ *http.Request, id string) {
	entry, err := config.RegenerateApiKey(id)
	if err != nil {
		if errors.Is(err, config.ErrApiKeyNotFound) {
			writeAdminError(w, http.StatusNotFound, codeAPIKeyNotFound, "API key not found")
			return
		}
		writeAdminErr(w, http.StatusInternalServerError, err, "")
		return
	}
	publishEvent(eventAPIKeysChanged, entry.ID)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"id":      entry.ID,
		"key":     entry.Key,
		"apiKey":  toApiKeyView(entry),
	})
}

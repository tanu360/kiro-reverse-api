package proxy

import (
	"strings"

	"kiro-proxy/config"
)

// storedRequestAPIKey is the client key a request row keeps: masked, never the raw value.
// A wrong key can be a real secret for another service, and a valid one is a live
// credential; rows of a valid key are matched by its id, not by this value.
func storedRequestAPIKey(apiKey string) string {
	return config.MaskApiKey(apiKey)
}

// requestKeySearch is what a request log search matches beyond the row's own columns, now
// that rows keep only masked keys: the ids of the configured keys whose value contains the
// search text, and, for a search that is a whole key, that key's masked form.
type requestKeySearch struct {
	ids    []string
	masked string
}

func newRequestKeySearch(search string) requestKeySearch {
	var ks requestKeySearch
	search = strings.TrimSpace(search)
	if search == "" {
		return ks
	}
	lower := strings.ToLower(search)
	for _, key := range config.ListApiKeys() {
		if key.ID != "" && key.Key != "" && strings.Contains(strings.ToLower(key.Key), lower) {
			ks.ids = append(ks.ids, key.ID)
		}
	}
	//! Short keys all mask to the same value, so only a longer search names one key.
	if len(search) > 10 && !strings.ContainsAny(search, " \t") {
		ks.masked = config.MaskApiKey(search)
	}
	return ks
}

// matches reports whether an in-memory row belongs to a key the search names.
func (ks requestKeySearch) matches(rec requestRecord) bool {
	if ks.masked != "" && rec.APIKey == ks.masked {
		return true
	}
	for _, id := range ks.ids {
		if rec.APIKeyID == id {
			return true
		}
	}
	return false
}

// sql is the extra OR clause and its arguments for the persisted search, or "".
func (ks requestKeySearch) sql() (string, []interface{}) {
	var parts []string
	var args []interface{}
	if len(ks.ids) > 0 {
		parts = append(parts, "api_key_id IN (?"+strings.Repeat(", ?", len(ks.ids)-1)+")")
		for _, id := range ks.ids {
			args = append(args, id)
		}
	}
	if ks.masked != "" {
		parts = append(parts, "api_key = ?")
		args = append(args, ks.masked)
	}
	if len(parts) == 0 {
		return "", nil
	}
	return " OR " + strings.Join(parts, " OR "), args
}

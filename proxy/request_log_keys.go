package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
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
	// hash is the search text's fingerprint: it finds rows of a key the proxy did not know.
	hash string
}

// unknownRequestKeyHash fingerprints a key that matched no configured key, for the search.
// Rows of a configured key are found by its id, so their key gets no fingerprint.
func unknownRequestKeyHash(apiKeyID, apiKey string) string {
	if apiKeyID != "" || apiKey == "" {
		return ""
	}
	return requestKeyHash(apiKey)
}

// requestKeyHash is a salted SHA-256 prefix: equal for equal keys, and too short and salted
// to look a key up by.
func requestKeyHash(apiKey string) string {
	sum := sha256.Sum256([]byte("kiro-proxy request log key\x00" + apiKey))
	return hex.EncodeToString(sum[:8])
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
	if !strings.ContainsAny(search, " \t") {
		ks.hash = requestKeyHash(search)
	}
	return ks
}

// matches reports whether an in-memory row belongs to a key the search names.
func (ks requestKeySearch) matches(rec requestRecord) bool {
	if ks.masked != "" && rec.APIKey == ks.masked {
		return true
	}
	if ks.hash != "" && rec.APIKeyHash == ks.hash {
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
	if ks.hash != "" {
		parts = append(parts, "api_key_hash = ?")
		args = append(args, ks.hash)
	}
	if len(parts) == 0 {
		return "", nil
	}
	return " OR " + strings.Join(parts, " OR "), args
}

// scrubStoredRequestKeys masks the client keys that older versions logged in full
// (db.MaskRequestKeys). A row that names a configured key by its raw value (a request
// refused for a disabled or used-up key, logged before the key id was kept) gets that
// key's id first, so usage by key still counts it under that key. A second run changes
// nothing. It runs once at start, before the request log is read.
func scrubStoredRequestKeys() error {
	keys := make(map[string]string)
	for _, key := range config.ListApiKeys() {
		if key.ID != "" && key.Key != "" {
			keys[key.Key] = key.ID
		}
	}
	n, err := db.MaskRequestKeys(keys)
	if err != nil {
		return err
	}
	if n > 0 {
		logger.Infof("[Observe] Masked the client key on %d older request log rows", n)
	}
	return nil
}

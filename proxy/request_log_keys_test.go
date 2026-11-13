package proxy

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
	"kiro-proxy/db"
)

// storedRequestKeys returns the api_key column of every logged request, oldest first.
func storedRequestKeys(t *testing.T) []string {
	t.Helper()
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	rows, err := d.Query(`SELECT api_key FROM requests ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	return keys
}

// The request log kept every key a client sent in full, valid or not, and showed a key of
// 10 characters or fewer unmasked.
func TestRequestLogNeverStoresRawClientKeys(t *testing.T) {
	served := &servedBy{}
	h := newKeyAccessHandler(t, recordingUpstream(t, served), "free-a")
	valid := addTestKey(t, config.ApiKeyEntry{Key: "sk-valid-request-log-0123456789abcdef"})
	requireKeys(t)

	sent := []string{valid.Key, "sk-wrong-key-for-test-0000", "sk-bogus"}
	for _, key := range sent {
		serveWithKey(h, http.MethodPost, "/v1/messages", key, boundKeyClaudeBody)
	}
	stored := storedRequestKeys(t)
	if len(stored) != len(sent) {
		t.Fatalf("stored keys %q, want %d rows", stored, len(sent))
	}
	for i, key := range sent {
		if stored[i] == "" || strings.Contains(stored[i], key) || stored[i] != config.MaskApiKey(key) {
			t.Fatalf("row %d stores %q for key %q, want the masked value %q", i, stored[i], key, config.MaskApiKey(key))
		}
	}

	page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10})
	for _, rec := range page.Requests {
		for _, key := range sent {
			if strings.Contains(rec.APIKeyMasked, key) || strings.Contains(rec.APIKey, key) {
				t.Fatalf("request log shows %q / %q for key %q", rec.APIKeyMasked, rec.APIKey, key)
			}
		}
	}
	for _, rec := range getObserveStore().RecentRequests(10) {
		if rec.APIKey == valid.Key || rec.APIKey == "sk-bogus" {
			t.Fatalf("in-memory row keeps the raw key %q", rec.APIKey)
		}
	}

	// Search still finds a valid key's rows by any part of its value, and a wrong key's row
	// by its whole value.
	for search, want := range map[string]int{"log-0123": 1, "sk-wrong-key-for-test-0000": 1, "for-test": 0} {
		if page := getObserveStore().RequestPage(requestQuery{Page: 1, PageSize: 10, Search: search}); page.Total != want {
			t.Fatalf("search %q found %d rows, want %d", search, page.Total, want)
		}
	}

	// The valid key's row is still counted under its key, the wrong ones as invalid.
	resp := mustUsage(t, observeNow(), "24h", 0)
	if e := usageEntry(t, resp, usageKindKey, valid.ID); e.Totals.Requests != 1 || e.KeyMasked != config.MaskApiKey(valid.Key) {
		t.Fatalf("valid key usage %+v", e)
	}
	if e := usageEntry(t, resp, usageKindInvalid, usageKindInvalid); e.Totals.Requests != 2 {
		t.Fatalf("invalid key usage %+v", e)
	}
}

func TestMaskApiKeyHidesShortKeys(t *testing.T) {
	for _, key := range []string{"sk-bogus", "abcdefghij", "x"} {
		if got := config.MaskApiKey(key); strings.Contains(got, key) || got == "" {
			t.Fatalf("MaskApiKey(%q) = %q", key, got)
		}
	}
	long := "sk-valid-request-log-0123456789abcdef"
	masked := config.MaskApiKey(long)
	if masked != "sk-val****cdef" || config.MaskApiKey(masked) != masked {
		t.Fatalf("MaskApiKey(%q) = %q, and masking it again gives %q", long, masked, config.MaskApiKey(masked))
	}
	if short := config.MaskApiKey("sk-bogus"); config.MaskApiKey(short) != short {
		t.Fatalf("masking a short key twice changes it: %q", short)
	}
}

// Rows logged before keys were masked: a configured key refused for being disabled (no key
// id then), a served one, a wrong key, a short one, and an already masked row.
func TestScrubStoredRequestKeysMasksOlderRows(t *testing.T) {
	setupApiKeyUsageTest(t)
	disabled := addUsageKey(t, "off", "sk-disabled-0123456789abcdef", false)
	served := addUsageKey(t, "on", "sk-served-0123456789abcdef", true)
	insertUsageRows(t,
		usageRow{ts: 100, key: disabled.Key},
		usageRow{ts: 101, keyID: served.ID, key: served.Key, success: true},
		usageRow{ts: 102, key: "sk-someone-elses-real-secret-0000"},
		usageRow{ts: 103, key: "sk-bogus"},
		usageRow{ts: 104, keyID: served.ID, key: config.MaskApiKey(served.Key), success: true},
		usageRow{ts: 105},
		usageRow{ts: 106, key: "ключ-чужой-секрет-0000"},
	)

	for run := 0; run < 2; run++ {
		if err := scrubStoredRequestKeys(); err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
		want := []string{
			config.MaskApiKey(disabled.Key), config.MaskApiKey(served.Key),
			config.MaskApiKey("sk-someone-elses-real-secret-0000"), "****",
			config.MaskApiKey(served.Key), "",
			//! The SQL mask counts bytes, as config.MaskApiKey does.
			config.MaskApiKey("ключ-чужой-секрет-0000"),
		}
		if got := storedRequestKeys(t); strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("run %d: stored keys %q, want %q", run, got, want)
		}
	}
	d, err := db.Get()
	if err != nil {
		t.Fatal(err)
	}
	var keyID string
	if err := d.QueryRow(`SELECT api_key_id FROM requests WHERE ts = 100`).Scan(&keyID); err != nil || keyID != disabled.ID {
		t.Fatalf("disabled key's row has key id %q (%v), want %q", keyID, err, disabled.ID)
	}
	resp := mustUsage(t, time.Unix(200, 0), "24h", 0)
	if e := usageEntry(t, resp, usageKindKey, disabled.ID); e.Totals.Requests != 1 {
		t.Fatalf("disabled key usage %+v", e)
	}
	if e := usageEntry(t, resp, usageKindInvalid, usageKindInvalid); e.Totals.Requests != 3 {
		t.Fatalf("invalid key usage %+v", e)
	}
}

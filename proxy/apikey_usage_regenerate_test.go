package proxy

import (
	"testing"
	"time"

	"kiro-proxy/config"
)

// Regenerating a key changes its value but keeps its ID, so the usage logged before and after
// stays one series under the key's current mask.
func TestApiKeyUsageKeepsOneSeriesAcrossRegenerate(t *testing.T) {
	setupApiKeyUsageTest(t)
	key := addUsageKey(t, "team", "sk-before-0123456789abcdef", true)
	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	insertUsageRows(t, usageRow{ts: now.Unix() - 600, keyID: key.ID, key: key.Key, success: true})

	fresh, err := config.RegenerateApiKey(key.ID)
	if err != nil {
		t.Fatalf("regenerate: %v", err)
	}
	if fresh.ID != key.ID || fresh.Key == key.Key {
		t.Fatalf("regenerate kept id %q -> %q, key changed %v", key.ID, fresh.ID, fresh.Key != key.Key)
	}
	insertUsageRows(t, usageRow{ts: now.Unix() - 60, keyID: key.ID, key: fresh.Key, success: true})

	resp := mustUsage(t, now, "24h", 0)
	if len(resp.Keys) != 1 {
		t.Fatalf("keys = %+v, want one series", resp.Keys)
	}
	e := usageEntry(t, resp, usageKindKey, key.ID)
	if e.Totals.Requests != 2 || e.KeyMasked != config.MaskApiKey(fresh.Key) {
		t.Fatalf("totals %+v masked %q, want 2 requests under the new key's mask", e.Totals, e.KeyMasked)
	}
}

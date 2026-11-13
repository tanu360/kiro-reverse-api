package proxy

import (
	"net/http"
	"net/http/httptest"
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

// A request refused for a disabled key is logged under the key's ID, so it stays in that key's
// series after the key is regenerated instead of moving to the invalid group.
func TestApiKeyUsageRefusedRequestStaysWithKeyAfterRegenerate(t *testing.T) {
	setupApiKeyUsageTest(t)
	key := addUsageKey(t, "team", "sk-refused-0123456789abcdef", false)
	required := true
	if err := config.UpdateSettingsPatch(&required, ""); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("X-Api-Key", key.Key)
	rec := httptest.NewRecorder()
	if (&Handler{}).authenticateForClaudeRequest(rec, req) != nil || rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled key: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := config.RegenerateApiKey(key.ID); err != nil {
		t.Fatal(err)
	}

	resp := mustUsage(t, time.Now(), "24h", 0)
	e := usageEntry(t, resp, usageKindKey, key.ID)
	if e.Totals.Requests != 1 || e.Totals.Failed != 1 || len(resp.Keys) != 1 {
		t.Fatalf("keys %+v, want the refused request under key %s", resp.Keys, key.ID)
	}
	if rejectedKeyID("sk-not-a-key-0123456789") != "" || rejectedKeyID("") != "" {
		t.Fatal("a value that names no key got a key ID")
	}
}

// A deleted key is labelled with the last value it sent, not the largest one.
func TestApiKeyUsageDeletedKeyShowsLastValue(t *testing.T) {
	setupApiKeyUsageTest(t)
	now := time.Date(2026, 3, 10, 14, 25, 0, 0, time.UTC)
	insertUsageRows(t,
		usageRow{ts: now.Unix() - 600, keyID: "gone-id", key: "sk-zzzz-old-0123456789abcdef", success: true},
		usageRow{ts: now.Unix() - 60, keyID: "gone-id", key: "sk-aaaa-new-0123456789abcdef", success: true},
	)
	e := usageEntry(t, mustUsage(t, now, "24h", 0), usageKindDeleted, "gone-id")
	if e.KeyMasked != config.MaskApiKey("sk-aaaa-new-0123456789abcdef") || e.Totals.Requests != 2 {
		t.Fatalf("deleted %+v, want the last value's mask", e)
	}
}

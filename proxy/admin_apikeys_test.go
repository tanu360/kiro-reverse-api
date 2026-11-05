package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"kiro-proxy/config"
)

func assertLockout(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["code"] != apiKeyLockoutCode || body["error"] != "would lock out every client" {
		t.Fatalf("body = %v", body)
	}
}

func TestApiKeyLockoutGuard(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}

	// Turning the requirement on with no enabled key.
	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"requireApiKey":true}`)))
	assertLockout(t, rec)
	if config.IsApiKeyRequired() {
		t.Fatal("requireApiKey was saved despite the 409")
	}

	only, err := config.AddApiKey(config.ApiKeyEntry{Key: "sk-only", Enabled: true})
	if err != nil {
		t.Fatalf("add key: %v", err)
	}
	rec = httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(`{"requireApiKey":true}`)))
	if rec.Code != http.StatusOK || !config.IsApiKeyRequired() {
		t.Fatalf("require with one enabled key: status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Disabling or deleting the last enabled key.
	rec = httptest.NewRecorder()
	h.apiUpdateApiKey(rec, httptest.NewRequest(http.MethodPut, "/admin/api/api-keys/"+only.ID, strings.NewReader(`{"enabled":false}`)), only.ID)
	assertLockout(t, rec)
	rec = httptest.NewRecorder()
	h.apiDeleteApiKey(rec, httptest.NewRequest(http.MethodDelete, "/admin/api/api-keys/"+only.ID, nil), only.ID)
	assertLockout(t, rec)
	if config.CountEnabledApiKeys() != 1 {
		t.Fatalf("enabled keys = %d after refused changes", config.CountEnabledApiKeys())
	}

	// Renaming the last key is not a lockout.
	rec = httptest.NewRecorder()
	h.apiUpdateApiKey(rec, httptest.NewRequest(http.MethodPut, "/admin/api/api-keys/"+only.ID, strings.NewReader(`{"name":"ci"}`)), only.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename: status=%d body=%s", rec.Code, rec.Body.String())
	}

	// With a second enabled key, the first can go.
	if _, err := config.AddApiKey(config.ApiKeyEntry{Key: "sk-second", Enabled: true}); err != nil {
		t.Fatalf("add second key: %v", err)
	}
	rec = httptest.NewRecorder()
	h.apiDeleteApiKey(rec, httptest.NewRequest(http.MethodDelete, "/admin/api/api-keys/"+only.ID, nil), only.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete with another enabled key: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestApiKeyChangesPublishEvent(t *testing.T) {
	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	id, ch := getBroadcaster().Subscribe()
	defer getBroadcaster().Unsubscribe(id)

	rec := httptest.NewRecorder()
	(&Handler{}).apiCreateApiKey(rec, httptest.NewRequest(http.MethodPost, "/admin/api/api-keys", strings.NewReader(`{"name":"ci"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create: status=%d body=%s", rec.Code, rec.Body.String())
	}
	waitForEvent(t, ch, eventAPIKeysChanged)
}

// waitForEvent drains ch until an event of the given type arrives.
func waitForEvent(t *testing.T, ch chan Event, eventType string) Event {
	t.Helper()
	timeout := time.After(time.Second)
	for {
		select {
		case evt := <-ch:
			if evt.Type == eventType {
				return evt
			}
		case <-timeout:
			t.Fatalf("no %s event", eventType)
			return Event{}
		}
	}
}

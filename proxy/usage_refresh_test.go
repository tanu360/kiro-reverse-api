package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kiro-proxy/config"
)

func getUsageRefreshSetting(t *testing.T, h *Handler) interface{} {
	t.Helper()
	rec := httptest.NewRecorder()
	h.apiGetSettings(rec, httptest.NewRequest(http.MethodGet, "/admin/api/settings", nil))
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got["usageRefreshIntervalMinutes"]
}

func postSettings(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.apiUpdateSettings(rec, httptest.NewRequest(http.MethodPost, "/admin/api/settings", strings.NewReader(body)))
	return rec
}

func TestUsageRefreshSettingsRoundTrip(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{usageRefresh: newRefreshScheduler(config.GetUsageRefreshInterval)}

	if got := getUsageRefreshSetting(t, h); got != float64(30) {
		t.Fatalf("default = %v, want 30", got)
	}

	for _, want := range []int{0, 15} {
		rec := postSettings(h, fmt.Sprintf(`{"usageRefreshIntervalMinutes":%d}`, want))
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %d: status=%d body=%s", want, rec.Code, rec.Body.String())
		}
		if got := getUsageRefreshSetting(t, h); got != float64(want) {
			t.Fatalf("after POST %d the setting reads %v", want, got)
		}
		select {
		case <-h.usageRefresh.wake:
		default:
			t.Fatalf("POST %d did not wake the sweep loop", want)
		}
	}
	if got := config.GetUsageRefreshInterval(); got != 15*time.Minute {
		t.Fatalf("interval = %s, want 15m", got)
	}

	// A patch without the field leaves it alone and does not wake the loop.
	if rec := postSettings(h, `{"autoContinue":false}`); rec.Code != http.StatusOK {
		t.Fatalf("unrelated patch: status=%d", rec.Code)
	}
	if len(h.usageRefresh.wake) != 0 || config.GetUsageRefreshIntervalMinutes() != 15 {
		t.Fatal("an unrelated patch touched the interval")
	}
}

func TestUsageRefreshSettingsRejectsOutOfRange(t *testing.T) {
	if err := config.Init(tempDBPath(t)); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	h := &Handler{}

	for _, bad := range []string{
		`{"usageRefreshIntervalMinutes":3}`,
		`{"usageRefreshIntervalMinutes":1441}`,
		`{"usageRefreshIntervalMinutes":-1}`,
		// Validated before anything is saved: the other field must not land either.
		`{"autoContinue":true,"usageRefreshIntervalMinutes":4}`,
	} {
		rec := postSettings(h, bad)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", bad, rec.Code)
		}
		if body := decodeAdminError(t, rec); body["code"] != codeUsageRefreshIntervalRange {
			t.Fatalf("%s: body=%v", bad, body)
		}
	}
	if got := config.GetUsageRefreshIntervalMinutes(); got != 30 {
		t.Fatalf("a rejected update changed the interval to %d", got)
	}
	if config.GetAutoContinue() {
		t.Fatal("a rejected patch still saved its other fields")
	}

	if rec := postSettings(h, `{"usageRefreshIntervalMinutes":"5"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("a string interval: status=%d, want 400", rec.Code)
	}
}

// A backup restore replaces the config without the settings API, so the sweep
// loop learns of it from the restore event.
func TestUsageRefreshWakesOnConfigEvents(t *testing.T) {
	h := &Handler{usageRefresh: newRefreshScheduler(func() time.Duration { return 0 })}
	// Room for every wake, so each event that wakes the loop leaves its own mark (the real
	// channel keeps one and drops the rest). Nothing else reads it here.
	wake := make(chan struct{}, 8)
	h.usageRefresh.wake = wake

	b := getBroadcaster()
	first := atomic.LoadUint64(&b.nextID) + 1
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.rescheduleOnConfigEvents(stop)
	}()
	defer func() {
		close(stop)
		<-done
	}()

	// The loop subscribes on its own goroutine: wait for it, so no event is published before.
	deadline := time.Now().Add(2 * time.Second)
	for subscribed := false; !subscribed; {
		b.mu.RLock()
		for id := range b.subscribers {
			subscribed = subscribed || id >= first
		}
		b.mu.RUnlock()
		if !subscribed {
			if time.Now().After(deadline) {
				t.Fatal("the sweep loop never subscribed to events")
			}
			time.Sleep(time.Millisecond)
		}
	}

	expectWake := func(what string) {
		t.Helper()
		select {
		case <-wake:
		case <-time.After(2 * time.Second):
			t.Fatalf("%s did not wake the sweep loop", what)
		}
	}
	publishEvent(eventBackupRestored, "")
	expectWake("a backup restore")
	publishEvent(eventSettingsChanged, "")
	expectWake("a settings change")

	// The loop reads events in order, so the settings change after the stats reset wakes it
	// once; a second wake could only be the stats reset's.
	publishEvent(eventStatsReset, "")
	publishEvent(eventSettingsChanged, "")
	expectWake("a settings change")
	select {
	case <-wake:
		t.Fatal("an unrelated event woke the sweep loop")
	case <-time.After(100 * time.Millisecond):
	}
}

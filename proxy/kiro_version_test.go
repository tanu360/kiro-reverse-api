package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAVersionGateRejectionRechecksTheFeedAtMostEveryTenMinutes(t *testing.T) {
	saved := kiroVersionRecheck
	t.Cleanup(func() {
		kiroVersionRecheck = saved
		lastGateRecheck.Store(0)
	})
	lastGateRecheck.Store(0)
	calls := 0
	kiroVersionRecheck = func() { calls++ }

	noteKiroVersionGate(`{"message":"Too many requests","reason":"USER_REQUEST_RATE_EXCEEDED"}`)
	if calls != 0 {
		t.Fatalf("another error rechecked the feed (%d)", calls)
	}
	gate := `{"message":"Please update to the latest version of Kiro.","reason":"FEATURE_NOT_SUPPORTED"}`
	noteKiroVersionGate(gate)
	noteKiroVersionGate(gate)
	if calls != 1 {
		t.Fatalf("rechecks = %d, want 1 within ten minutes", calls)
	}
	lastGateRecheck.Store(lastGateRecheck.Load() - int64(kiroGateRecheckGap))
	noteKiroVersionGate(gate)
	if calls != 2 {
		t.Errorf("rechecks after ten minutes = %d, want 2", calls)
	}
}

func TestFetchKiroVersionReadsTheCurrentRelease(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.Write([]byte(`{"currentRelease":"1.4.178","releases":[{"version":"1.4.178"}]}`))
		case "/empty":
			w.Write([]byte(`{"releases":[]}`))
		default:
			http.Error(w, "gone", http.StatusNotFound)
		}
	}))
	defer srv.Close()

	got, err := fetchKiroVersion(context.Background(), srv.Client(), srv.URL+"/ok")
	if err != nil || got != "1.4.178" {
		t.Fatalf("fetchKiroVersion = %q, %v", got, err)
	}
	if _, err := fetchKiroVersion(context.Background(), srv.Client(), srv.URL+"/empty"); err == nil {
		t.Error("a feed with no currentRelease was accepted")
	}
	if _, err := fetchKiroVersion(context.Background(), srv.Client(), srv.URL+"/missing"); err == nil {
		t.Error("a 404 was accepted")
	}
}

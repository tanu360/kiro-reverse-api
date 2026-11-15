package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

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

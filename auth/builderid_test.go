package auth

import (
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A slow_down poll raises the session's interval while the admin handler reads it for its
// answer; the read goes through GetBuilderIdSession's copy, so the two never race (go test -race).
func TestBuilderIdIntervalReadDuringSlowDown(t *testing.T) {
	old := SetGlobalAuthClientForTest(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadRequest,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"error":"slow_down"}`)),
		}, nil
	})})
	t.Cleanup(func() { SetGlobalAuthClientForTest(old) })

	const id = "test-slow-down"
	builderIdMu.Lock()
	builderIdSessions[id] = &BuilderIdSession{ID: id, Interval: 5, Region: "us-east-1", ExpiresAt: time.Now().Add(time.Minute)}
	builderIdMu.Unlock()
	t.Cleanup(func() {
		builderIdMu.Lock()
		delete(builderIdSessions, id)
		builderIdMu.Unlock()
	})

	const polls = 20
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for range polls {
			if _, _, _, _, _, _, status, err := PollBuilderIdAuth(id); err != nil || status != "slow_down" {
				t.Errorf("poll = %q, %v; want slow_down", status, err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for range polls {
			if session, ok := GetBuilderIdSession(id); !ok || session.Interval < 5 {
				t.Errorf("session = %+v, %v", session, ok)
				return
			}
		}
	}()
	wg.Wait()

	session, ok := GetBuilderIdSession(id)
	if !ok || session.Interval != 5+5*polls {
		t.Fatalf("interval = %d, want %d", session.Interval, 5+5*polls)
	}
}

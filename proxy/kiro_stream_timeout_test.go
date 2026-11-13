package proxy

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestKiroStreamClientHasNoTotalTimeout(t *testing.T) {
	//! Upstream Kiro-Go #133: Client.Timeout also bounds the body and cut every turn past five minutes.
	oldStream, oldRest := kiroHttpStore.Load(), kiroRestHttpStore.Load()
	t.Cleanup(func() {
		kiroHttpStore.Store(oldStream)
		kiroRestHttpStore.Store(oldRest)
	})
	InitKiroHttpClient("")

	const proxyURL = "http://127.0.0.1:1"
	t.Cleanup(func() { proxyClientCache.Delete(proxyURL) })
	for name, client := range map[string]*http.Client{
		"default": kiroHttpStore.Load(),
		"proxied": GetClientForProxy(proxyURL),
	} {
		if client.Timeout != 0 {
			t.Fatalf("%s stream client has a total timeout %v", name, client.Timeout)
		}
		base := client.Transport
		if bounded, isBounded := base.(interface{ Unwrap() http.RoundTripper }); isBounded {
			base = bounded.Unwrap()
		}
		transport, ok := base.(*http.Transport)
		if !ok || transport.ResponseHeaderTimeout <= 0 {
			t.Fatalf("%s stream client needs a response header timeout, got %#v", name, client.Transport)
		}
	}
	if kiroRestHttpStore.Load().Timeout <= 0 {
		t.Fatal("REST calls must keep their total timeout")
	}
}

func setStreamIdleTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	old := kiroStreamIdleTimeout
	kiroStreamIdleTimeout = d
	t.Cleanup(func() { kiroStreamIdleTimeout = old })
}

func hangUntilClientLeaves(w http.ResponseWriter, r *http.Request, frames ...[]byte) {
	w.WriteHeader(http.StatusOK)
	for _, frame := range frames {
		_, _ = w.Write(frame)
	}
	w.(http.Flusher).Flush()
	select {
	case <-r.Context().Done():
	case <-time.After(5 * time.Second):
	}
}

func TestCallKiroAPIIdleStreamFailsSoftly(t *testing.T) {
	setStreamIdleTimeout(t, 100*time.Millisecond)
	var calls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		hangUntilClientLeaves(w, r, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}))
	})
	h.pool.RecordSuccess("only")
	t.Cleanup(func() { h.pool.RecordSuccess("only") })

	start := time.Now()
	err := CallKiroAPIContext(context.Background(), testAccount(t), testKiroPayload(), &KiroStreamCallback{OnText: func(string, bool) {}})
	if !errors.Is(err, errKiroStreamIdle) || !isStreamIntegrityError(err) {
		t.Fatalf("expected a soft idle-stream error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("idle stream detected too late: %v", elapsed)
	}
	if calls.Load() != 1 {
		t.Fatalf("output already reached the caller, so no retry is allowed; got %d calls", calls.Load())
	}
	h.handleAccountFailure(testAccount(t), err)
	if until := h.pool.CooldownUntil("only"); !until.IsZero() {
		t.Fatalf("an idle upstream stream must not cool the account, cooldown until %v", until)
	}
}

func TestCallKiroAPIRetriesIdleStreamBeforeOutput(t *testing.T) {
	setStreamIdleTimeout(t, 100*time.Millisecond)
	var calls atomic.Int32
	newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			hangUntilClientLeaves(w, r)
			return
		}
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "second try"}), meteringFrame(t))
	})

	var text string
	err := CallKiroAPIContext(context.Background(), testAccount(t), testKiroPayload(), &KiroStreamCallback{OnText: func(s string, _ bool) { text += s }})
	if err != nil || calls.Load() != 2 || text != "second try" {
		t.Fatalf("err=%v calls=%d text=%q, want the silent attempt retried", err, calls.Load(), text)
	}
}

func TestCallKiroAPISlowSteadyStreamOutlivesIdleTimeout(t *testing.T) {
	setStreamIdleTimeout(t, 150*time.Millisecond)
	newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		for i := 0; i < 8; i++ {
			_, _ = w.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "x"}))
			w.(http.Flusher).Flush()
			time.Sleep(50 * time.Millisecond)
		}
		_, _ = w.Write(meteringFrame(t))
	})

	var text string
	err := CallKiroAPIContext(context.Background(), testAccount(t), testKiroPayload(), &KiroStreamCallback{OnText: func(s string, _ bool) { text += s }})
	if err != nil || text != "xxxxxxxx" {
		t.Fatalf("a stream longer than the idle timeout but never silent must finish; err=%v text=%q", err, text)
	}
}

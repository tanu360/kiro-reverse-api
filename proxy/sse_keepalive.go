package proxy

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	//! Clients abort a stream that stays quiet past their chunk timeout (upstream Kiro-Go #133):
	//! tool arguments are held until the tool completes, and reasoning can be silent for minutes.
	sseKeepaliveInterval = 15 * time.Second

	sseCommentKeepalive = []byte(": keepalive\n\n")
	claudePingKeepalive = []byte("event: ping\ndata: {\"type\": \"ping\"}\n\n")
)

type sseKeepaliveWriter struct {
	//! Every write and flush holds mu, so a keepalive never lands inside an event.
	http.ResponseWriter
	flusher   http.Flusher
	frame     []byte
	interval  time.Duration
	mu        sync.Mutex
	lastWrite time.Time
	running   bool
	closed    bool
	stop      chan struct{}
	done      chan struct{}
}

func newSSEKeepaliveWriter(w http.ResponseWriter, flusher http.Flusher, frame []byte) *sseKeepaliveWriter {
	return &sseKeepaliveWriter{
		ResponseWriter: w,
		flusher:        flusher,
		frame:          frame,
		interval:       sseKeepaliveInterval,
		stop:           make(chan struct{}),
		done:           make(chan struct{}),
	}
}

func (k *sseKeepaliveWriter) Write(p []byte) (int, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	n, err := k.ResponseWriter.Write(p)
	k.lastWrite = time.Now()
	//! Keepalives start only once the event stream is committed. Before that an upstream
	//! failure must still answer with a real HTTP status, and the handler may retry.
	if !k.running && !k.closed && n > 0 && strings.HasPrefix(k.Header().Get("Content-Type"), "text/event-stream") {
		k.running = true
		go k.run()
	}
	return n, err
}

func (k *sseKeepaliveWriter) Flush() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.flusher.Flush()
}

func (k *sseKeepaliveWriter) Unwrap() http.ResponseWriter {
	return k.ResponseWriter
}

func (k *sseKeepaliveWriter) Close() {
	//! A ResponseWriter must not be touched after the handler returns, so wait for the loop.
	k.mu.Lock()
	k.closed = true
	running := k.running
	k.mu.Unlock()
	if running {
		close(k.stop)
		<-k.done
	}
}

func (k *sseKeepaliveWriter) run() {
	defer close(k.done)
	timer := time.NewTimer(k.interval)
	defer timer.Stop()
	for {
		select {
		case <-k.stop:
			return
		case <-timer.C:
		}
		k.mu.Lock()
		if k.closed {
			k.mu.Unlock()
			return
		}
		wait := k.interval - time.Since(k.lastWrite)
		if wait <= 0 {
			_, _ = k.ResponseWriter.Write(k.frame)
			k.flusher.Flush()
			k.lastWrite = time.Now()
			wait = k.interval
		}
		k.mu.Unlock()
		timer.Reset(wait)
	}
}

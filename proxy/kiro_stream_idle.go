package proxy

import (
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

var (
	//! A generation turn may run far longer than any fixed deadline; only silence proves it died.
	kiroStreamIdleTimeout   = 3 * time.Minute
	kiroStreamHeaderTimeout = 5 * time.Minute
)

func newKiroStreamClient(proxyURL string) *http.Client {
	//! No Client.Timeout: it also bounds reading the body, which cut every turn longer than
	//! five minutes (upstream Kiro-Go #133). Headers get a deadline, the body an idle timeout.
	transport := buildKiroTransport(proxyURL)
	transport.ResponseHeaderTimeout = kiroStreamHeaderTimeout
	return &http.Client{Transport: transport}
}

type idleTimeoutBody struct {
	//! The watchdog runs only while a Read waits, so a slow client never counts as upstream silence.
	body  io.ReadCloser
	idle  time.Duration
	timer *time.Timer
	fired atomic.Bool
}

func newIdleTimeoutBody(body io.ReadCloser, idle time.Duration) *idleTimeoutBody {
	b := &idleTimeoutBody{body: body, idle: idle}
	b.timer = time.AfterFunc(idle, func() {
		b.fired.Store(true)
		//! Closing the body is what unblocks a Read stuck on a silent connection.
		_ = body.Close()
	})
	b.timer.Stop()
	return b
}

func (b *idleTimeoutBody) Read(p []byte) (int, error) {
	if b.fired.Load() {
		return 0, b.idleError()
	}
	b.timer.Reset(b.idle)
	n, err := b.body.Read(p)
	b.timer.Stop()
	if err != nil && b.fired.Load() {
		return n, b.idleError()
	}
	return n, err
}

func (b *idleTimeoutBody) idleError() error {
	return fmt.Errorf("%w: no data for %s", errKiroStreamIdle, b.idle)
}

func (b *idleTimeoutBody) Close() error {
	b.timer.Stop()
	return b.body.Close()
}

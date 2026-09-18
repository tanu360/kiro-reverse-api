package proxy

import (
	"kiro-proxy/config"
	"kiro-proxy/pool"
	"testing"
	"time"
)

// Request tests share package-level config and transports. A timer left behind
// by an earlier handler must not refresh the next test's accounts.
func newHandlerWithoutBackgroundForTest(t *testing.T) *Handler {
	t.Helper()
	applyProxyConfig(config.GetProxyURL())
	if err := getObserveStore().LoadFromDB(); err != nil {
		t.Fatal(err)
	}
	return &Handler{
		pool: pool.GetPool(), startTime: time.Now().Unix(),
		stopRefresh: make(chan struct{}), stopStatsSaver: make(chan struct{}),
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL), affinity: newSessionAffinity(), adminSessions: newAdminSessionStore(),
	}
}

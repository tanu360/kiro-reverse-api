package proxy

import (
	"bytes"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogs routes every logger level into a buffer at debug level until the
// test ends.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	prevLevel := logger.GetLevel()
	logger.SetLevel(logger.LevelDebug)
	logger.SetOutput(buf)
	t.Cleanup(func() {
		logger.SetOutput(os.Stderr)
		logger.SetLevel(prevLevel)
	})
	return buf
}

func TestPickAccountLogsOnlyWhenConversationLeavesBoundAccount(t *testing.T) {
	h := affinityTestHandler(t, "aff-a", "aff-b")
	logs := captureLogs(t)
	conv := payloadFor("conversation")
	h.affinity.Bind(affinityKey(conv), "aff-a")

	if acc := h.pickAccount(conv, "", nil); acc == nil || acc.ID != "aff-a" {
		t.Fatalf("bound turn went to %v, want aff-a", acc)
	}
	if strings.Contains(logs.String(), "[SessionAffinity]") {
		t.Fatalf("a turn that stayed on its account logged a move:\n%s", logs)
	}

	h.pickAccount(conv, "", map[string]bool{"aff-a": true})
	want := "[SessionAffinity] Bound account aff-a unavailable, conversation moved to aff-b@example.com"
	if !strings.Contains(logs.String(), want) {
		t.Fatalf("missing %q in logs:\n%s", want, logs)
	}
}

func TestRefreshAllAccountsLogsSweepSummary(t *testing.T) {
	// No access tokens, so the sweep visits both accounts without calling upstream.
	h := affinityTestHandler(t, "sweep-a", "sweep-b")
	logs := captureLogs(t)

	h.refreshAllAccounts()

	want := "[BackgroundRefresh] Sweep finished: 2 accounts in "
	if !strings.Contains(logs.String(), want) || !strings.Contains(logs.String(), "(2 workers)") {
		t.Fatalf("missing sweep summary in logs:\n%s", logs)
	}
}

func TestWriteMicrosoftAddedLogsOutcome(t *testing.T) {
	h := affinityTestHandler(t)
	logs := captureLogs(t)
	account := config.Account{ID: "ms-log", Email: "dev.user@contoso.onmicrosoft.com", Region: "us-east-1"}

	h.writeMicrosoftAdded(httptest.NewRecorder(), account, "")
	if want := "INFO  "; !strings.Contains(logs.String(), want) ||
		!strings.Contains(logs.String(), "[MicrosoftSSO] Added dev.user@contoso.onmicrosoft.com (region us-east-1)") {
		t.Fatalf("missing info line for a complete login:\n%s", logs)
	}

	h.writeMicrosoftAdded(httptest.NewRecorder(), account, "profile lookup failed")
	if !strings.Contains(logs.String(), "WARN  ") ||
		!strings.Contains(logs.String(), "[MicrosoftSSO] dev.user@contoso.onmicrosoft.com: profile lookup failed") {
		t.Fatalf("missing warning line for a login without a profile:\n%s", logs)
	}
}

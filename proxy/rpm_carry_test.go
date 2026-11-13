package proxy

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"kiro-proxy/config"
)

// A web search loop is one client request: its rounds and MCP searches take
// one start against the per-account RPM limit, not one each.
func TestWebSearchLoopTakesOneRPMStart(t *testing.T) {
	var upstreamCalls atomic.Int32
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		switch upstreamCalls.Add(1) {
		case 1:
			writeFrames(w, webSearchToolUseFrame(t, "toolu_ws_1", "go release"), meteringFrame(t))
		default:
			writeKiroTextResponse(t, w, "Go 1.26 is the latest.")
		}
	})
	stub := stubMCPWebSearch(t, http.StatusOK, mcpOneResult)
	clearRPMStarts(h.pool)
	t.Cleanup(func() { clearRPMStarts(h.pool) })
	if err := config.UpdateAccountRPMLimit(1); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"claude-sonnet-4.5","max_tokens":64,
		"tools":[{"type":"web_search_20250305","name":"web_search"}],
		"messages":[{"role":"user","content":"What is the latest Go?"}]}`
	rec := postClaudeMessages(t, h, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("web search loop with a limit of 1 = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if upstreamCalls.Load() != 2 || stub.calls.Load() != 1 {
		t.Fatalf("model calls=%d MCP calls=%d, want 2 and 1", upstreamCalls.Load(), stub.calls.Load())
	}
	if at := h.pool.AtRPMLimit(); !at["only"] {
		t.Fatalf("AtRPMLimit = %v, want the account at its one start", at)
	}
	// The request held exactly one start: the next request is over the limit.
	rec = postClaudeMessages(t, h, `{"model":"claude-sonnet-4.5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "per minute") {
		t.Fatalf("next request = %d %s, want 429", rec.Code, rec.Body.String())
	}

	// With a limit of 2 the loop leaves one start free for another request.
	clearRPMStarts(h.pool)
	if err := config.UpdateAccountRPMLimit(2); err != nil {
		t.Fatal(err)
	}
	upstreamCalls.Store(0)
	if rec := postClaudeMessages(t, h, body); rec.Code != http.StatusOK {
		t.Fatalf("loop with a limit of 2 = %d %s", rec.Code, rec.Body.String())
	}
	if at := h.pool.AtRPMLimit(); at["only"] {
		t.Fatal("one web search request filled a limit of 2")
	}
}

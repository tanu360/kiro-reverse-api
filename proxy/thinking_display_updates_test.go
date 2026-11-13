package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Claude Code in stream-json or verbose mode and the Agent SDK send display "updates"
// (beta thinking-display-updates-2026-08-18). Each process got two 400s before it dropped
// the field.
func TestThinkingDisplayUpdatesIsAccepted(t *testing.T) {
	updates := &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048, Display: "updates"}
	if msg := validateClaudeThinkingConfig(updates, 4096); msg != "" {
		t.Fatalf("enabled + updates refused: %q", msg)
	}
	if msg := validateClaudeThinkingConfig(&ClaudeThinkingConfig{Type: "adaptive", Display: "Updates"}, 4096); msg != "" {
		t.Fatalf("adaptive + updates refused: %q", msg)
	}
	if msg := validateClaudeThinkingConfig(&ClaudeThinkingConfig{Type: "disabled", Display: "updates"}, 4096); msg == "" {
		t.Fatal("disabled + updates accepted")
	}
	if msg := validateClaudeThinkingConfig(&ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048, Display: "verbose"}, 4096); !strings.Contains(msg, "updates") {
		t.Fatalf("unknown display: %q, want the list of values to name updates", msg)
	}

	//! Kiro has no between-tool progress notes; its thinking text is the closest thing,
	//! and the CLI got exactly that after it dropped display.
	opts := resolveClaudeThinkingResponseOptions(updates, "reasoning_content")
	if opts.Format != "thinking" || opts.OmitDisplay {
		t.Fatalf("updates resolved to %+v, want thinking blocks with their text", opts)
	}
}

func TestThinkingDisplayUpdatesOnMessagesAndCountTokens(t *testing.T) {
	h := newStreamTestHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		writeFrames(w, answerFrame(t, "<thinking>plan</thinking>\n\nOK"), meteringFrame(t))
	})
	body := `{"model":"claude-haiku-4.5","max_tokens":4096,"stream":true,` +
		`"thinking":{"type":"enabled","budget_tokens":2048,"display":"updates"},` +
		`"messages":[{"role":"user","content":"Reply with OK"}]}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
	req.Header.Set("anthropic-beta", "thinking-display-updates-2026-08-18")
	h.ServeHTTP(rec, req)
	var counted struct {
		InputTokens int `json:"input_tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &counted); rec.Code != http.StatusOK || err != nil || counted.InputTokens < 1 {
		t.Fatalf("count_tokens: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = postClaudeMessages(t, h, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("messages: status=%d body=%s", rec.Code, rec.Body.String())
	}
	steps := strings.Join(claudeSSESummary(t, rec.Body.String()), "|")
	if !strings.Contains(steps, "start:0:thinking|delta:0:thinking_delta:plan|stop:0|start:1:text") {
		t.Fatalf("stream steps %s, want a thinking block with its text before the answer", steps)
	}
}

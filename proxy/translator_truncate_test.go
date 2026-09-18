package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClaudeToKiroTruncatesOversizedHistory(t *testing.T) {
	//! Kiro rejects oversized input with CONTENT_LENGTH_EXCEEDS_THRESHOLD; old history goes first.
	big := strings.Repeat("lorem ipsum dolor sit amet ", 80)

	msgs := []ClaudeMessage{
		{Role: "user", Content: "start the long task"},
	}
	for i := 0; i < 800; i++ {
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: "step result: " + big},
			ClaudeMessage{Role: "user", Content: "next: " + big},
		)
	}
	msgs = append(msgs, ClaudeMessage{Role: "user", Content: "FINAL: summarize everything above"})

	req := &ClaudeRequest{
		Model:    "claude-opus-4.8",
		System:   "You are a helpful assistant.",
		Messages: msgs,
	}

	payload := ClaudeToKiro(req, false)

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if len(raw) > maxPayloadBytes {
		t.Fatalf("payload size %d exceeds limit %d after truncation", len(raw), maxPayloadBytes)
	}

	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if !strings.Contains(cur.Content, "FINAL: summarize everything above") {
		t.Fatalf("current message lost after truncation, got %q", cur.Content[:min(80, len(cur.Content))])
	}

	foundPlaceholder := false
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil && strings.Contains(h.UserInputMessage.Content, "truncated to fit") {
			foundPlaceholder = true
			break
		}
	}
	if !foundPlaceholder {
		t.Fatalf("expected a truncation placeholder in history")
	}

	if len(payload.ConversationState.History) < 2 {
		t.Fatalf("expected priming retained, history too short")
	}
	primingUser := payload.ConversationState.History[0].UserInputMessage
	if primingUser == nil || !strings.Contains(primingUser.Content, "helpful assistant") {
		t.Fatalf("expected system priming retained at front")
	}
}

func TestClaudeToKiroSmallPayloadNotTruncated(t *testing.T) {
	req := &ClaudeRequest{
		Model:  "claude-opus-4.8",
		System: "You are helpful.",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "hi"},
			{Role: "user", Content: "how are you?"},
		},
	}
	payload := ClaudeToKiro(req, false)
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil && strings.Contains(h.UserInputMessage.Content, "truncated to fit") {
			t.Fatalf("small payload should not be truncated")
		}
	}
}

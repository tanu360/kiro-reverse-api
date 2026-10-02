package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestClaudeToKiroPreservesOversizedHistory(t *testing.T) {
	big := strings.Repeat("long history with exact text ", 80)
	messages := []ClaudeMessage{{Role: "user", Content: "START"}}
	for i := 0; i < 800; i++ {
		messages = append(messages,
			ClaudeMessage{Role: "assistant", Content: fmt.Sprintf("RESULT_%d %s", i, big)},
			ClaudeMessage{Role: "user", Content: fmt.Sprintf("NEXT_%d %s", i, big)},
		)
	}
	messages = append(messages, ClaudeMessage{Role: "user", Content: "FINAL"})
	payload := ClaudeToKiro(&ClaudeRequest{Model: "claude-opus-5.5", System: "  SYSTEM\n", Messages: messages}, false)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 900*1024 {
		t.Fatalf("fixture no longer exceeds the old cap: %d", len(raw))
	}
	for _, message := range messages[:len(messages)-1] {
		found := false
		for _, history := range payload.ConversationState.History {
			if history.UserInputMessage != nil && history.UserInputMessage.Content == message.Content {
				found = true
			}
			if history.AssistantResponseMessage != nil && history.AssistantResponseMessage.Content == message.Content {
				found = true
			}
		}
		if !found {
			t.Fatalf("lost history message %.50s", message.Content)
		}
	}
	if payload.ConversationState.History[0].UserInputMessage.Content != "  SYSTEM\n" {
		t.Fatal("system whitespace changed")
	}
	if payload.ConversationState.CurrentMessage.UserInputMessage.Content != "FINAL" {
		t.Fatal("current text changed")
	}
}

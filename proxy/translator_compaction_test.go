package proxy

import (
	"strings"
	"testing"
)

func TestClaudeToKiroFlattensHistoryToolCyclesForCompaction(t *testing.T) {
	//! Regression from upstream #104: Kiro answers 400 "Improperly formed request" to structured tool history.
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "run the build"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "text", "text": "running build"},
				map[string]interface{}{"type": "tool_use", "id": "t1", "name": "exec_command", "input": map[string]interface{}{"cmd": "make"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "build ok"},
			}},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "tool_use", "id": "t2", "name": "exec_command", "input": map[string]interface{}{"cmd": "test"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t2", "content": "tests pass"},
			}},
			{Role: "user", Content: "Summarize everything that happened above."},
		},
	}

	payload := ClaudeToKiro(req, false)

	for i, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && len(h.AssistantResponseMessage.ToolUses) > 0 {
			t.Fatalf("history[%d] still has structured toolUses; upstream rejects this", i)
		}
		if h.UserInputMessage != nil && h.UserInputMessage.UserInputMessageContext != nil {
			if len(h.UserInputMessage.UserInputMessageContext.ToolResults) > 0 {
				t.Fatalf("history[%d] still has structured toolResults; upstream rejects this", i)
			}
		}
	}

	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if cur.UserInputMessageContext != nil && len(cur.UserInputMessageContext.ToolResults) > 0 {
		t.Fatalf("current message should not carry structured toolResults for a plain instruction")
	}
	if !strings.Contains(cur.Content, "Summarize everything") {
		t.Fatalf("expected current content to be the compaction instruction, got %q", cur.Content)
	}

	var historyText strings.Builder
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil {
			historyText.WriteString(h.AssistantResponseMessage.Content)
			historyText.WriteString("\n")
		}
		if h.UserInputMessage != nil {
			historyText.WriteString(h.UserInputMessage.Content)
			historyText.WriteString("\n")
		}
	}
	combined := historyText.String()
	if !strings.Contains(combined, "exec_command") {
		t.Fatalf("expected narrated tool calls to mention exec_command, got:\n%s", combined)
	}
	if !strings.Contains(combined, "tests pass") {
		t.Fatalf("expected narrated tool results to retain output, got:\n%s", combined)
	}

	for i, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			if strings.Contains(a.Content, "[Called tool") {
				t.Fatalf("history[%d] assistant content contains mimicable tool-invocation text: %q", i, a.Content)
			}
		}
	}
	if !strings.Contains(combined, "[exec_command]") {
		t.Fatalf("expected tool results to be attributed to exec_command on the user side, got:\n%s", combined)
	}
}

func TestClaudeToKiroKeepsActiveToolTurnStructured(t *testing.T) {
	//! Only the in-flight pair (last assistant toolUses + current toolResults) stays structured.
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Tools: []ClaudeTool{{Name: "exec_command", Description: "run", InputSchema: map[string]interface{}{"type": "object"}}},
		Messages: []ClaudeMessage{
			{Role: "user", Content: "run ls"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "tool_use", "id": "t9", "name": "exec_command", "input": map[string]interface{}{"cmd": "ls"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t9", "content": "file1 file2"},
			}},
		},
	}

	payload := ClaudeToKiro(req, false)

	hist := payload.ConversationState.History
	if len(hist) == 0 {
		t.Fatalf("expected non-empty history")
	}
	last := hist[len(hist)-1].AssistantResponseMessage
	if last == nil || len(last.ToolUses) != 1 || last.ToolUses[0].ToolUseID != "t9" {
		t.Fatalf("expected last history assistant to keep the active structured tool use t9")
	}

	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if cur.UserInputMessageContext == nil || len(cur.UserInputMessageContext.ToolResults) != 1 {
		t.Fatalf("expected current message to keep the matching structured tool result")
	}
	if cur.UserInputMessageContext.ToolResults[0].ToolUseID != "t9" {
		t.Fatalf("expected current tool result to answer t9, got %q", cur.UserInputMessageContext.ToolResults[0].ToolUseID)
	}
}

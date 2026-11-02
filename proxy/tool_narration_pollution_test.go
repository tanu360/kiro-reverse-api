package proxy

import (
	"fmt"
	"strings"
	"testing"
)

func TestNoToolInvocationTextInAssistantHistory(t *testing.T) {
	//! Tool calls narrated in assistant turns taught the model to type them instead of calling tools.
	msgs := []OpenAIMessage{{Role: "user", Content: "start a multi-step task"}}
	for i := 0; i < 8; i++ {
		msgs = append(msgs,
			OpenAIMessage{Role: "assistant", Content: "", ToolCalls: []ToolCall{
				testToolCall(fmt.Sprintf("call_%d", i), "exec_command", fmt.Sprintf(`{"cmd":"step %d"}`, i)),
			}},
			OpenAIMessage{Role: "tool", ToolCallID: fmt.Sprintf("call_%d", i), Content: fmt.Sprintf("OUTPUT_%d", i)},
			OpenAIMessage{Role: "user", Content: fmt.Sprintf("continue %d", i)},
		)
	}
	msgs = append(msgs, OpenAIMessage{Role: "user", Content: "summarize"})

	for _, structured := range []bool{false, true} {
		t.Run(map[bool]string{false: "narrated", true: "structured"}[structured], func(t *testing.T) {
			setStructuredToolHistoryForTest(t, structured)
			payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs, Tools: []OpenAITool{testOpenAIFunctionTool("exec_command")}}, false)

			calls := 0
			for i, h := range payload.ConversationState.History {
				a := h.AssistantResponseMessage
				if a == nil {
					continue
				}
				for _, bad := range []string{"[Called tool", "Called tool ", "with input {"} {
					if strings.Contains(a.Content, bad) {
						t.Fatalf("history[%d] assistant content contains mimicable tool text %q: %q", i, bad, a.Content)
					}
				}
				calls += len(a.ToolUses)
			}

			var allText strings.Builder
			for _, h := range payload.ConversationState.History {
				if u := h.UserInputMessage; u != nil {
					allText.WriteString(u.Content)
					allText.WriteString("\n")
					if u.UserInputMessageContext != nil {
						for _, tr := range u.UserInputMessageContext.ToolResults {
							for _, c := range tr.Content {
								allText.WriteString(c.Text + "\n")
							}
						}
					}
				}
			}
			combined := allText.String()
			for i := 0; i < 8; i++ {
				marker := fmt.Sprintf("OUTPUT_%d", i)
				if !strings.Contains(combined, marker) {
					t.Fatalf("tool output %q lost from history", marker)
				}
			}
			if !structured {
				if calls > 0 {
					t.Fatalf("narrated history retains %d structured toolUses", calls)
				}
				if !strings.Contains(combined, "[exec_command]") {
					t.Fatalf("expected tool results attributed to exec_command on the user side")
				}
				return
			}
			//! Structured mode shows the model its own earlier calls (upstream issue #170).
			if calls != 8 {
				t.Fatalf("structured history kept %d toolUses, want 8", calls)
			}
			if strings.Contains(combined, "[exec_command]") {
				t.Fatalf("structured results must not also be narrated")
			}
			assertToolHistoryPaired(t, payload)
		})
	}
}

func TestCollapsesConsecutiveIdenticalToolResults(t *testing.T) {
	msgs := []OpenAIMessage{{Role: "user", Content: "start"}}
	for i := 0; i < 5; i++ {
		msgs = append(msgs,
			OpenAIMessage{Role: "assistant", Content: "", ToolCalls: []ToolCall{
				testToolCall(fmt.Sprintf("c%d", i), "exec_command", `{"cmd":"x"}`),
			}},
			OpenAIMessage{Role: "tool", ToolCallID: fmt.Sprintf("c%d", i), Content: "SAME_ERROR_OUTPUT"},
		)
	}
	msgs = append(msgs, OpenAIMessage{Role: "user", Content: "final"})

	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-opus-4.8", Messages: msgs}, false)

	count := 0
	for _, h := range payload.ConversationState.History {
		if h.UserInputMessage != nil && strings.Contains(h.UserInputMessage.Content, "SAME_ERROR_OUTPUT") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected 5 identical tool-result turns collapsed to 1, got %d", count)
	}
}

func TestDropsDotPollutedAssistantTurns(t *testing.T) {
	//! A history of "." placeholder turns teaches the model to answer ".".
	msgs := []ClaudeMessage{{Role: "user", Content: "start"}}
	for i := 0; i < 6; i++ {
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: "[Called tool exec_command with input {\"cmd\":\"x\"}]"},
			ClaudeMessage{Role: "user", Content: "continue"},
		)
		msgs = append(msgs,
			ClaudeMessage{Role: "assistant", Content: "."},
			ClaudeMessage{Role: "user", Content: "go on"},
		)
	}
	msgs = append(msgs, ClaudeMessage{Role: "user", Content: "final question"})

	payload := ClaudeToKiro(&ClaudeRequest{Model: "claude-opus-4.8", Messages: msgs}, false)

	for i, h := range payload.ConversationState.History {
		a := h.AssistantResponseMessage
		if a == nil {
			continue
		}
		c := strings.TrimSpace(a.Content)
		if c == "." || c == "" {
			t.Fatalf("history[%d] is a hollow/dot assistant turn that should have been dropped", i)
		}
		if strings.Contains(a.Content, "[Called tool") {
			t.Fatalf("history[%d] still contains replayed tool-call text", i)
		}
	}
}

func TestScrubsClientReplayedToolCallText(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "do the task"},
			{Role: "assistant", Content: "Let me check.\n\n[Called tool exec_command with input {\"cmd\":\"pwd\"}]"},
			{Role: "user", Content: "continue"},
			{Role: "assistant", Content: "[Called tool exec_command with input {\"cmd\":\"ls\"}]"},
			{Role: "user", Content: "continue"},
		},
	}

	payload := ClaudeToKiro(req, false)

	for i, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			if strings.Contains(a.Content, "[Called tool") {
				t.Fatalf("history[%d] still contains replayed tool-call text: %q", i, a.Content)
			}
		}
	}

	var combined strings.Builder
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil {
			combined.WriteString(h.AssistantResponseMessage.Content)
			combined.WriteString("\n")
		}
	}
	if !strings.Contains(combined.String(), "Let me check.") {
		t.Fatalf("expected surrounding assistant prose to survive scrubbing, got:\n%s", combined.String())
	}
}

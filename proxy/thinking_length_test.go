package proxy

import (
	"strings"
	"testing"
)

func payloadText(t *testing.T, payload *KiroPayload) string {
	t.Helper()
	var b strings.Builder
	for _, message := range payload.ConversationState.History {
		if message.UserInputMessage != nil {
			b.WriteString(message.UserInputMessage.Content + "\n")
		}
	}
	b.WriteString(payload.ConversationState.CurrentMessage.UserInputMessage.Content)
	return b.String()
}

func TestThinkingLengthFollowsTheClaudeBudget(t *testing.T) {
	for _, history := range []bool{false, true} {
		req := &ClaudeRequest{
			Model:     "claude-sonnet-4.5",
			MaxTokens: 4000,
			System:    "Be brief.",
			Thinking:  &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048},
			Messages:  []ClaudeMessage{{Role: "user", Content: "What is 6*7?"}},
		}
		if history {
			req.Messages = []ClaudeMessage{
				{Role: "user", Content: "Hi"},
				{Role: "assistant", Content: "Hello."},
				{Role: "user", Content: "What is 6*7?"},
			}
		}
		payload := ClaudeToKiro(req, true)
		if !strings.Contains(payloadText(t, payload), "<max_thinking_length>200000</max_thinking_length>") {
			t.Fatalf("the translator adds the default prompt first")
		}
		applyClaudeThinkingBudget(payload, req.Thinking)
		text := payloadText(t, payload)
		if !strings.Contains(text, "<max_thinking_length>2048</max_thinking_length>") || strings.Contains(text, "200000") {
			t.Fatalf("history=%t: the prompt must ask for the 2048-token budget: %s", history, text)
		}
	}
}

func TestThinkingLengthFollowsTheReasoningEffort(t *testing.T) {
	h := &Handler{}
	for effort, want := range map[string]string{"low": "4000", "medium": "10000", "high": "32000", "xhigh": "64000", "max": "64000"} {
		req := &OpenAIRequest{Model: "claude-sonnet-4.5", Messages: []OpenAIMessage{{Role: "user", Content: "Think about 6*7."}}}
		payload := OpenAIToKiro(req, true)
		h.applyReasoningEffort(payload, req.Model, effort)
		if text := payloadText(t, payload); !strings.Contains(text, "<max_thinking_length>"+want+"</max_thinking_length>") {
			t.Fatalf("effort %s: want length %s in %s", effort, want, text)
		}
	}
}

func TestThinkingLengthLeavesPayloadsWithoutThinkingAlone(t *testing.T) {
	req := &OpenAIRequest{Model: "claude-haiku-4.5", Messages: []OpenAIMessage{{Role: "user", Content: "Hi"}}}
	payload := OpenAIToKiro(req, false)
	before := payloadText(t, payload)
	setThinkingLength(payload, 4000)
	applyClaudeThinkingBudget(payload, &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048})
	if payloadText(t, payload) != before {
		t.Fatalf("a payload without the thinking prompt must not change")
	}
	adaptive := ClaudeToKiro(&ClaudeRequest{Model: "claude-sonnet-4.5", MaxTokens: 100, Messages: []ClaudeMessage{{Role: "user", Content: "Hi"}}}, true)
	applyClaudeThinkingBudget(adaptive, &ClaudeThinkingConfig{Type: "adaptive"})
	if !strings.Contains(payloadText(t, adaptive), "<max_thinking_length>200000") {
		t.Fatalf("adaptive thinking has no budget and keeps the default length")
	}
}

// Kiro's listing, live: DeepSeek, GLM, Qwen, MiniMax and the Claude 4.5 models have no request
// fields; GPT, Grok and Kimi take reasoning.effort, newer Claude models thinking and output_config.
func thinkingInstructionHandler() *Handler {
	reasoning := map[string]interface{}{"properties": map[string]interface{}{"reasoning": map[string]interface{}{}}}
	thinking := map[string]interface{}{"properties": map[string]interface{}{"thinking": map[string]interface{}{}}}
	return &Handler{cachedModels: []ModelInfo{
		{ModelId: "deepseek-3.2"},
		{ModelId: "glm-5"},
		{ModelId: "claude-sonnet-4.5"},
		{ModelId: "auto"},
		{ModelId: "gpt-5.6-sol", AdditionalModelRequestFieldsSchema: reasoning},
		{ModelId: "claude-opus-4.8", AdditionalModelRequestFieldsSchema: thinking},
	}}
}

func TestThinkingInstructionAsksModelsThatIgnoreTheTags(t *testing.T) {
	h := thinkingInstructionHandler()
	for _, tc := range []struct {
		model string
		want  bool
	}{
		{"deepseek-3.2-thinking", true},
		{"glm-5-thinking", true},
		{"claude-sonnet-4.5-thinking", false},
		{"auto-thinking", false},
		{"gpt-5.6-sol-thinking", false},
		{"claude-opus-4.8-thinking", false},
		{"unlisted-model-thinking", false},
	} {
		for _, history := range []bool{false, true} {
			req := &OpenAIRequest{Model: tc.model, Messages: []OpenAIMessage{{Role: "system", Content: "Be brief."}, {Role: "user", Content: "What is 6*7?"}}}
			if history {
				req.Messages = append(req.Messages[:1], OpenAIMessage{Role: "user", Content: "Hi"}, OpenAIMessage{Role: "assistant", Content: "Hello."}, OpenAIMessage{Role: "user", Content: "What is 6*7?"})
			}
			payload := OpenAIToKiro(req, true)
			h.applyReasoningEffort(payload, req.Model, "low")
			h.applyThinkingInstruction(payload)
			text := payloadText(t, payload)
			if got := strings.Contains(text, thinkingInstruction); got != tc.want {
				t.Fatalf("%s history=%t: instruction added = %t, want %t:\n%s", tc.model, history, got, tc.want, text)
			}
			if tc.want && !strings.Contains(text, "<max_thinking_length>4000</max_thinking_length>\n"+thinkingInstruction) {
				t.Fatalf("%s history=%t: the instruction must follow the prompt with its effort length:\n%s", tc.model, history, text)
			}
			if strings.Count(text, thinkingInstruction) > 1 {
				t.Fatalf("%s: instruction added twice:\n%s", tc.model, text)
			}
		}
	}
}

func TestThinkingInstructionNeedsTheThinkingPrompt(t *testing.T) {
	h := thinkingInstructionHandler()
	payload := OpenAIToKiro(&OpenAIRequest{Model: "deepseek-3.2", Messages: []OpenAIMessage{{Role: "user", Content: "Hi"}}}, false)
	before := payloadText(t, payload)
	h.applyThinkingInstruction(payload)
	if payloadText(t, payload) != before {
		t.Fatalf("thinking off: the payload must not change")
	}
}

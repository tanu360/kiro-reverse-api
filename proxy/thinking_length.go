package proxy

import (
	"strconv"
	"strings"
)

// defaultThinkingLength is the <max_thinking_length> of the thinking prompt when the client
// gives neither a budget nor an effort level.
const defaultThinkingLength = 200000

// effortThinkingLength is the thinking length for a reasoning effort on a model without an
// effort setting of its own. low, medium and high follow Claude Code's "think", "think hard"
// and "ultrathink" budgets.
var effortThinkingLength = map[string]int{
	effortLow:    4000,
	effortMedium: 10000,
	effortHigh:   32000,
	effortXHigh:  64000,
}

// minThinkingLength is the smallest budget the Messages API takes.
const minThinkingLength = 1024

func thinkingModePrompt(length int) string {
	return strings.Replace(ThinkingModePrompt, strconv.Itoa(defaultThinkingLength), strconv.Itoa(length), 1)
}

// setThinkingLength puts length into the thinking prompt the translator added to the payload.
// A payload without the prompt (thinking off) is left alone.
func setThinkingLength(payload *KiroPayload, length int) {
	if payload == nil || length < minThinkingLength || length == defaultThinkingLength {
		return
	}
	replacement := thinkingModePrompt(length)
	current := &payload.ConversationState.CurrentMessage.UserInputMessage
	if strings.Contains(current.Content, ThinkingModePrompt) {
		current.Content = strings.Replace(current.Content, ThinkingModePrompt, replacement, 1)
		return
	}
	for i := range payload.ConversationState.History {
		message := payload.ConversationState.History[i].UserInputMessage
		if message != nil && strings.Contains(message.Content, ThinkingModePrompt) {
			message.Content = strings.Replace(message.Content, ThinkingModePrompt, replacement, 1)
			return
		}
	}
}

// applyClaudeThinkingBudget makes the thinking prompt ask for the client's budget_tokens.
func applyClaudeThinkingBudget(payload *KiroPayload, thinking *ClaudeThinkingConfig) {
	if thinking == nil || !strings.EqualFold(strings.TrimSpace(thinking.Type), "enabled") {
		return
	}
	setThinkingLength(payload, thinking.BudgetTokens)
}

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

// setThinkingLength puts length into the thinking prompt the translator added to the payload.
// A payload without the prompt (thinking off) is left alone.
func setThinkingLength(payload *KiroPayload, length int) {
	if payload == nil || length < minThinkingLength {
		return
	}
	current := &payload.ConversationState.CurrentMessage.UserInputMessage
	if replaceThinkingLength(&current.Content, length) {
		return
	}
	for i := range payload.ConversationState.History {
		message := payload.ConversationState.History[i].UserInputMessage
		if message != nil && replaceThinkingLength(&message.Content, length) {
			return
		}
	}
}

// replaceThinkingLength puts length between the thinking prompt's <max_thinking_length> tags in
// content. It looks for the tags rather than ThinkingModePrompt, whose length an earlier call
// (the reasoning effort's) may have changed.
func replaceThinkingLength(content *string, length int) bool {
	start := strings.Index(*content, thinkingModeOpen+"\n"+thinkingLengthOpenTag)
	if start == -1 {
		return false
	}
	from := start + len(thinkingModeOpen+"\n"+thinkingLengthOpenTag)
	end := strings.Index((*content)[from:], thinkingLengthCloseTag)
	if end == -1 {
		return false
	}
	*content = (*content)[:from] + strconv.Itoa(length) + (*content)[from+end:]
	return true
}

// applyClaudeThinkingBudget makes the thinking prompt ask for the client's budget_tokens. It runs
// after applyReasoningEffort, so an explicit budget wins over the effort's length.
func applyClaudeThinkingBudget(payload *KiroPayload, thinking *ClaudeThinkingConfig) {
	if thinking == nil || !strings.EqualFold(strings.TrimSpace(thinking.Type), "enabled") {
		return
	}
	setThinkingLength(payload, thinking.BudgetTokens)
}

// thinkingInstruction asks in plain words for what the thinking prompt's tags ask for. Claude
// and MiniMax read <thinking_mode>; DeepSeek, GLM and Qwen ignored it and never thought, live,
// but follow this sentence.
const thinkingInstruction = "Before you respond, reason step by step inside <thinking> and </thinking> tags, then give your response after the closing tag."

const (
	thinkingModeOpen       = "<thinking_mode>enabled</thinking_mode>"
	thinkingLengthOpenTag  = "<max_thinking_length>"
	thinkingLengthCloseTag = "</max_thinking_length>"
)

// applyThinkingInstruction adds thinkingInstruction after the thinking prompt the translator put
// in the payload, for a model that only thinks when asked in words (needsThinkingInstruction).
func (h *Handler) applyThinkingInstruction(payload *KiroPayload) {
	if payload == nil || !h.needsThinkingInstruction(currentMessageModelID(payload)) {
		return
	}
	current := &payload.ConversationState.CurrentMessage.UserInputMessage
	if insertThinkingInstruction(&current.Content) {
		return
	}
	for i := range payload.ConversationState.History {
		message := payload.ConversationState.History[i].UserInputMessage
		if message != nil && insertThinkingInstruction(&message.Content) {
			return
		}
	}
}

// insertThinkingInstruction puts thinkingInstruction after the thinking prompt in content. It
// looks for the prompt's tags rather than ThinkingModePrompt, whose length setThinkingLength may
// have changed.
func insertThinkingInstruction(content *string) bool {
	start := strings.Index(*content, thinkingModeOpen)
	if start == -1 {
		return false
	}
	end := strings.Index((*content)[start:], thinkingLengthCloseTag)
	if end == -1 {
		return false
	}
	at := start + end + len(thinkingLengthCloseTag)
	*content = (*content)[:at] + "\n" + thinkingInstruction + (*content)[at:]
	return true
}

// needsThinkingInstruction reports whether model needs thinkingInstruction: Kiro lists it with
// no thinking, reasoning or effort setting of its own, and it is neither a Claude model nor auto,
// which read the prompt's tags. A model Kiro has not listed keeps the prompt as it is, since a
// model with its own reasoning would write that reasoning as text.
func (h *Handler) needsThinkingInstruction(model string) bool {
	id := strings.ToLower(strings.TrimSpace(model))
	if id == "" || id == "auto" || strings.HasPrefix(id, "claude-") {
		return false
	}
	schema, listed := h.modelRequestFieldsSchema(id)
	if !listed {
		return false
	}
	properties, _ := nestedSchemaMap(schema, "properties")
	for _, setting := range []string{"thinking", "reasoning", "output_config"} {
		if _, ok := properties[setting]; ok {
			return false
		}
	}
	return true
}

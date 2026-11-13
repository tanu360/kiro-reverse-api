package proxy

import (
	"kiro-proxy/logger"
	"kiro-proxy/textfmt"
	"strconv"
	"strings"
)

//! Kiro history has no reasoning field: assistantResponseMessage.reasoningContent is
//! rejected with "400 Improperly formed request". Thinking a client sends back is replayed
//! as <thinking>…</thinking> segments in the assistant content, in block order, which is
//! the same shape thinking-mode models write inline. redacted_thinking blocks are encrypted
//! and signatures only mean something to Anthropic, so both are dropped.

// claudeThinkingReplay decides, assistant message by assistant message, whether the
// thinking blocks a client sent back are replayed into Kiro history.
type claudeThinkingReplay struct {
	enabled bool
	// finished is how many assistant messages belong to turns that already ended.
	finished int
	ordinal  int
}

// newClaudeThinkingReplay follows Anthropic's thinking caching rules. The current turn's
// tool loop always keeps its thinking. Thinking from finished turns is kept only by models
// that keep prior thinking in context. With thinking off nothing is replayed, so the model
// is not taught to write <thinking> tags into a plain answer.
func newClaudeThinkingReplay(messages []ClaudeMessage, modelID string, thinking bool) *claudeThinkingReplay {
	replay := &claudeThinkingReplay{enabled: thinking}
	if thinking && !modelKeepsPriorThinking(modelID) {
		replay.finished = finishedClaudeAssistantTurns(messages)
	}
	return replay
}

// next reports whether the next assistant message, in request order, keeps its thinking.
func (r *claudeThinkingReplay) next() bool {
	if r == nil {
		return false
	}
	keep := r.enabled && r.ordinal >= r.finished
	r.ordinal++
	return keep
}

// finishedClaudeAssistantTurns counts the assistant messages before the turn in progress.
// A turn starts at the last user message with content other than tool results. It counts
// on the raw messages: role normalization turns system messages into user messages but
// never reorders assistant messages, and a system message does not start a turn.
func finishedClaudeAssistantTurns(messages []ClaudeMessage) int {
	boundary := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" && claudeUserMessageStartsTurn(messages[i].Content) {
			boundary = i
			break
		}
	}
	finished := 0
	for i := 0; i < boundary; i++ {
		if messages[i].Role == "assistant" {
			finished++
		}
	}
	return finished
}

func claudeUserMessageStartsTurn(content interface{}) bool {
	switch value := content.(type) {
	case string:
		return strings.TrimSpace(value) != ""
	case []interface{}:
		for _, item := range value {
			block, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			switch block["type"] {
			case "tool_result":
				continue
			case "text":
				if text, _ := block["text"].(string); strings.TrimSpace(text) != "" {
					return true
				}
			default:
				return true
			}
		}
	}
	return false
}

// modelKeepsPriorThinking reports whether a model keeps thinking from finished turns in
// its context. Per Anthropic's extended thinking docs, Opus 4.5 and later do; earlier
// models drop it once a user message other than a tool result arrives. Sonnet 4.6+,
// Haiku 5+ and any generation-5 model follow the new rule. Non-Claude models do not.
func modelKeepsPriorThinking(modelID string) bool {
	id := strings.ToLower(strings.TrimSpace(modelID))
	rest, ok := strings.CutPrefix(id, "claude-")
	if !ok {
		return false
	}
	family, version, _ := strings.Cut(rest, "-")
	//! Generation-first ids such as claude-3-7-sonnet or claude-5.
	if generation, err := strconv.Atoi(family); err == nil {
		return generation >= 5
	}
	major, minor, ok := leadingVersion(version)
	if !ok {
		return false
	}
	switch family {
	case "opus":
		return major > 4 || (major == 4 && minor >= 5)
	case "sonnet":
		return major > 4 || (major == 4 && minor >= 6)
	default:
		return major >= 5
	}
}

// leadingVersion reads "4.6", "4-6" or "4-5-20250929" as major 4 and minor 6 or 5.
func leadingVersion(version string) (int, int, bool) {
	parts := strings.FieldsFunc(version, func(r rune) bool { return r == '.' || r == '-' })
	if len(parts) == 0 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor := 0
	if len(parts) > 1 {
		if n, err := strconv.Atoi(parts[1]); err == nil {
			minor = n
		}
	}
	return major, minor, true
}

// extractClaudeAssistantHistory converts one assistant message for Kiro history. Content
// without thinking blocks, or whose thinking is not kept, converts exactly as before.
func extractClaudeAssistantHistory(content interface{}, keepThinking bool) (string, []KiroToolUse) {
	blocks, ok := content.([]interface{})
	if !ok {
		return extractClaudeAssistantContent(content)
	}
	thinkingBlocks, redactedBlocks := countClaudeThinkingBlocks(blocks)
	if redactedBlocks > 0 {
		logger.Debugf("[ThinkingHistory] Dropping %s: Kiro cannot replay encrypted reasoning",
			textfmt.Count(redactedBlocks, "redacted_thinking block", "redacted_thinking blocks"))
	}
	if thinkingBlocks == 0 || !keepThinking {
		return extractClaudeAssistantContent(content)
	}

	var segments []string
	var toolUses []KiroToolUse
	var run []interface{}
	flush := func() {
		if len(run) == 0 {
			return
		}
		text, tools := extractClaudeAssistantContent(run)
		if text != "" {
			segments = append(segments, text)
		}
		toolUses = append(toolUses, tools...)
		run = nil
	}
	for _, item := range blocks {
		block, _ := item.(map[string]interface{})
		switch block["type"] {
		case "thinking":
			flush()
			if text, _ := block["thinking"].(string); text != "" {
				segments = append(segments, thinkingOpenTag+text+thinkingCloseTag)
			}
		case "redacted_thinking":
			flush()
		default:
			run = append(run, item)
		}
	}
	flush()
	return strings.Join(segments, "\n\n"), toolUses
}

func countClaudeThinkingBlocks(blocks []interface{}) (thinking, redacted int) {
	for _, item := range blocks {
		block, _ := item.(map[string]interface{})
		switch block["type"] {
		case "thinking":
			thinking++
		case "redacted_thinking":
			redacted++
		}
	}
	return thinking, redacted
}

package proxy

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

//! Thinking a client sends back reaches Kiro only as reasoning, never as text: Claude 5
//! models answer stop_reason "refusal" to a history whose assistant content holds earlier
//! reasoning as <thinking> text. Signed thinking and redacted_thinking blocks travel as
//! KiroAssistantResponseMessage.Reasoning (generateAssistantResponse's reasoningContent, or
//! CreateResponse reasoning items); thinking without a signature cannot, so it is dropped.

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
// that keep prior thinking in context. With thinking off nothing is replayed.
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

// claudeAssistantReasoning collects the signed thinking and redacted_thinking blocks of an
// assistant message that keeps its thinking, in order. A thinking block without a signature,
// or with no text (display "omitted"), cannot be replayed and is left out.
func claudeAssistantReasoning(content interface{}, keepThinking bool) []KiroReasoningBlock {
	blocks, ok := content.([]interface{})
	if !ok || !keepThinking {
		return nil
	}
	var out []KiroReasoningBlock
	for _, item := range blocks {
		block, _ := item.(map[string]interface{})
		switch block["type"] {
		case "thinking":
			text, _ := block["thinking"].(string)
			signature, _ := block["signature"].(string)
			if text != "" && signature != "" {
				out = append(out, KiroReasoningBlock{Text: text, Signature: signature})
			}
		case "redacted_thinking":
			if data, _ := block["data"].(string); data != "" {
				out = append(out, KiroReasoningBlock{RedactedContent: data})
			}
		}
	}
	return out
}

// withoutReplayedReasoning is the payload without the reasoning its history replays. The
// history is copied, so the caller's payload, which account failover sends again, keeps it.
func withoutReplayedReasoning(payload *KiroPayload) *KiroPayload {
	stripped := *payload
	stripped.ConversationState.History = make([]KiroHistoryMessage, len(payload.ConversationState.History))
	for i, entry := range payload.ConversationState.History {
		if a := entry.AssistantResponseMessage; a != nil && len(a.Reasoning) > 0 {
			copied := *a
			copied.Reasoning = nil
			entry.AssistantResponseMessage = &copied
		}
		stripped.ConversationState.History[i] = entry
	}
	return &stripped
}

// isReasoningRejection reports Kiro's 400 for replayed reasoning it does not accept. Both
// chat APIs answer it the same way (recorded live): reason THINKING_SIGNATURE_INVALID,
// "messages.N.content.0: Invalid `signature` in `thinking` block".
func isReasoningRejection(err error) bool {
	var client *upstreamClientError
	return errors.As(err, &client) && client.status == http.StatusBadRequest && strings.Contains(client.message, "THINKING_SIGNATURE_INVALID")
}

// legacyReplaysReasoning reports whether the payload's generateAssistantResponse body carries
// reasoning: a history assistant message with exactly one block (MarshalJSON).
func legacyReplaysReasoning(payload *KiroPayload) bool {
	for _, entry := range payload.ConversationState.History {
		if a := entry.AssistantResponseMessage; a != nil && len(a.Reasoning) == 1 {
			return true
		}
	}
	return false
}

// reasoningOutsideJSONBytes counts the replayed reasoning that a message's JSON leaves out:
// generateAssistantResponse carries a single block, CreateResponse carries every one.
func reasoningOutsideJSONBytes(a *KiroAssistantResponseMessage) int {
	if a == nil || len(a.Reasoning) < 2 {
		return 0
	}
	n := 0
	for _, b := range a.Reasoning {
		n += len(b.Text) + len(b.Signature) + len(b.RedactedContent)
	}
	return n
}

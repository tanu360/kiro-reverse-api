package proxy

//! Kiro's reasoningContentEvent is flat: {"text"?, "signature"?, "redactedContent"?}, the same
//! shape as Bedrock's ReasoningContentBlockDelta. The signature usually comes as its own event
//! after the block's last text. Only /v1/messages has a place for either field: a thinking
//! block's `signature` and a `redacted_thinking` block. The proxy never checks signatures.

// reasoningEventExtras hands a reasoning event's signature and redacted content to the
// callback. It reports whether an output callback ran.
func reasoningEventExtras(event map[string]interface{}, callback *KiroStreamCallback, turn *streamTurnSignals) bool {
	emitted := false
	if signature, ok := event["signature"].(string); ok && signature != "" && callback.OnThinkingSignature != nil {
		emitted = true
		callback.OnThinkingSignature(signature)
	}
	if redacted, ok := event["redactedContent"].(string); ok && redacted != "" {
		//! Encrypted reasoning is still reasoning: a turn that sent only this is not empty.
		turn.sawReasoning = true
		if callback.OnRedactedThinking != nil {
			emitted = true
			callback.OnRedactedThinking(redacted)
		}
	}
	return emitted
}

// claudeThinkingExtrasEnabled reports whether a response can carry signatures and
// redacted_thinking blocks. The text formats "think" and "reasoning_content" have no
// place for them; every other format renders reasoning as thinking blocks.
func claudeThinkingExtrasEnabled(thinking bool, format string) bool {
	return thinking && format != "think" && format != "reasoning_content"
}

func claudeSignatureDeltaEvent(index int, signature string) map[string]interface{} {
	return map[string]interface{}{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]string{"type": "signature_delta", "signature": signature},
	}
}

func claudeRedactedThinkingStartEvent(index int, data string) map[string]interface{} {
	return map[string]interface{}{
		"type":          "content_block_start",
		"index":         index,
		"content_block": map[string]string{"type": "redacted_thinking", "data": data},
	}
}

// applyClaudeThinkingExtras gives a non-stream response's leading thinking block its
// signature and places redacted_thinking blocks right after it, before text and tools.
// A signature with no thinking block to carry it is dropped.
func applyClaudeThinkingExtras(blocks []ClaudeContentBlock, signature string, redacted []string) []ClaudeContentBlock {
	if signature == "" && len(redacted) == 0 {
		return blocks
	}
	insertAt := 0
	if len(blocks) > 0 && blocks[0].Type == "thinking" {
		blocks[0].Signature = signature
		insertAt = 1
	}
	if len(redacted) == 0 {
		return blocks
	}
	result := make([]ClaudeContentBlock, 0, len(blocks)+len(redacted))
	result = append(result, blocks[:insertAt]...)
	for _, data := range redacted {
		result = append(result, ClaudeContentBlock{Type: "redacted_thinking", Data: data})
	}
	return append(result, blocks[insertAt:]...)
}

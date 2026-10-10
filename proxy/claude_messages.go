package proxy

// normalizeClaudeMessageRoles folds message-level role "system" entries (sent
// mid-conversation by Claude Code) into user turns, since Kiro only has
// user/assistant turns. A system entry merges with an adjacent user turn, or
// becomes a user turn on its own; ordinary messages are left unchanged. The
// input slice and its content are not mutated.
func normalizeClaudeMessageRoles(messages []ClaudeMessage) []ClaudeMessage {
	hasSystem := false
	for _, message := range messages {
		if message.Role == "system" {
			hasSystem = true
			break
		}
	}
	if !hasSystem {
		return messages
	}

	result := make([]ClaudeMessage, 0, len(messages))
	previousSystem := false
	for _, message := range messages {
		isSystem := message.Role == "system"
		if isSystem {
			message.Role = "user"
		}
		if message.Role == "user" && len(result) > 0 && result[len(result)-1].Role == "user" && (isSystem || previousSystem) {
			previous := &result[len(result)-1]
			//! Text blocks are concatenated without a separator; keep the turns apart.
			blocks := append(claudeMessageBlocks(previous.Content), map[string]interface{}{"type": "text", "text": "\n"})
			previous.Content = append(blocks, claudeMessageBlocks(message.Content)...)
		} else {
			result = append(result, message)
		}
		previousSystem = isSystem
	}
	return result
}

func claudeMessageBlocks(content interface{}) []interface{} {
	switch value := content.(type) {
	case string:
		return []interface{}{map[string]interface{}{"type": "text", "text": value}}
	case []interface{}:
		return append([]interface{}(nil), value...)
	case map[string]interface{}:
		return []interface{}{value}
	}
	return nil
}

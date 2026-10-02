package proxy

// Kiro only has user/assistant turns. Keep message-level system instructions
// where they occurred, rather than moving them ahead of earlier conversation.
// Merge with an adjacent user turn; a standalone instruction becomes a user
// turn when no adjacent user exists. Ordinary messages are left unchanged.
func normalizeClaudeMessageRoles(messages []ClaudeMessage) []ClaudeMessage {
	result := make([]ClaudeMessage, 0, len(messages))
	previousSystem := false
	for _, message := range messages {
		isSystem := message.Role == "system"
		if isSystem {
			message.Role = "user"
		}
		if message.Role == "user" && len(result) > 0 && result[len(result)-1].Role == "user" && (isSystem || previousSystem) {
			previous := &result[len(result)-1]
			blocks := claudeMessageBlocks(*previous)
			// Separate message boundaries without changing the original text.
			blocks = append(blocks, map[string]interface{}{"type": "text", "text": "\n"})
			previous.Content = append(blocks, claudeMessageBlocks(message)...)
			// Message-level cache boundaries now live on their original blocks.
			previous.CacheControl = nil
		} else {
			result = append(result, message)
		}
		previousSystem = isSystem
	}
	return result
}

func claudeMessageBlocks(message ClaudeMessage) []interface{} {
	var blocks []interface{}
	switch content := message.Content.(type) {
	case string:
		blocks = []interface{}{map[string]interface{}{"type": "text", "text": content}}
	case []interface{}:
		blocks = append([]interface{}(nil), content...)
	case map[string]interface{}:
		blocks = []interface{}{content}
	}
	if len(message.CacheControl) > 0 && len(blocks) > 0 {
		if last, ok := blocks[len(blocks)-1].(map[string]interface{}); ok {
			copy := make(map[string]interface{}, len(last)+1)
			for key, value := range last {
				copy[key] = value
			}
			copy["cache_control"] = message.CacheControl
			blocks[len(blocks)-1] = copy
		}
	}
	return blocks
}

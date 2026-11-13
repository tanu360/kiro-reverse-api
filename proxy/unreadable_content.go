package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

//! A content block, content part or input item of a type the proxy does not know is skipped, so
//! a client that sends a newer type next to text keeps working. When nothing readable is left,
//! the request is refused anyway, and the refusal now names the first item it skipped: "at least
//! one non-empty user message is required" sent the client looking in the wrong place.

// claudeReadableBlocks are the content block types the Messages translation reads.
var claudeReadableBlocks = map[string]bool{
	"text": true, "input_text": true, "image": true, "image_url": true, "input_image": true,
	"document": true, "file": true, "input_file": true, "tool_result": true, "tool_use": true,
	"server_tool_use": true, "web_search_tool_result": true, "thinking": true, "redacted_thinking": true,
}

// openAIReadableParts are the content part types the Chat and Responses translations read.
var openAIReadableParts = map[string]bool{
	"text": true, "input_text": true, "output_text": true, "refusal": true, "image": true,
	"image_url": true, "input_image": true, "file": true, "input_file": true,
}

// responsesReadableItems are the input item types responseInputItemToMessages turns into messages.
var responsesReadableItems = map[string]bool{
	"": true, "message": true, "additional_tools": true, "agent_message": true, "input_text": true,
	"output_text": true, "function_call": true, "function_call_output": true, "custom_tool_call": true,
	"custom_tool_call_output": true, "tool_search_call": true, "tool_search_output": true,
}

// unreadableType says why the proxy skipped value, named by field, or "" when it reads its type.
func unreadableType(field string, value interface{}, readable map[string]bool) string {
	obj, ok := value.(map[string]interface{})
	if !ok {
		return ""
	}
	switch kind := obj["type"].(type) {
	case nil:
		return field + " has no type, so this proxy cannot read it"
	case string:
		if strings.TrimSpace(kind) == "" {
			return field + " has no type, so this proxy cannot read it"
		}
		if !readable[kind] {
			return fmt.Sprintf("%s has type %q, which this proxy cannot read", field, kind)
		}
		return ""
	default:
		return fmt.Sprintf("%s.type must be a string, not %s", field, jsonValueKind(kind))
	}
}

// unreadableClaudeBlock names the first block of a user turn that the proxy skipped, in the
// Messages API's field names. A mid-conversation "system" entry is folded into a user turn.
func unreadableClaudeBlock(messages []ClaudeMessage) string {
	for i, message := range messages {
		if role := strings.TrimSpace(message.Role); role != "user" && role != "system" {
			continue
		}
		blocks, _ := message.Content.([]interface{})
		for j, block := range blocks {
			if msg := unreadableType(fmt.Sprintf("messages.%d.content.%d", i, j), block, claudeReadableBlocks); msg != "" {
				return msg
			}
		}
	}
	return ""
}

// unreadableChatPart names the first content part of a user message that the proxy skipped.
func unreadableChatPart(messages []OpenAIMessage) string {
	for i, message := range messages {
		if strings.TrimSpace(message.Role) != "user" {
			continue
		}
		parts, _ := message.Content.([]interface{})
		for j, part := range parts {
			if msg := unreadableType(fmt.Sprintf("messages[%d].content[%d]", i, j), part, openAIReadableParts); msg != "" {
				return msg
			}
		}
	}
	return ""
}

// unreadableResponsesInput names the first input item, or content part of a user message item,
// that the proxy skipped, as the client wrote the input.
func unreadableResponsesInput(raw json.RawMessage) string {
	var items []interface{}
	fields := []string{}
	if err := json.Unmarshal(raw, &items); err == nil {
		for i := range items {
			fields = append(fields, fmt.Sprintf("input[%d]", i))
		}
	} else {
		var obj map[string]interface{}
		if json.Unmarshal(raw, &obj) != nil {
			return ""
		}
		items, fields = []interface{}{obj}, []string{"input"}
	}
	for i, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		itemType, _ := obj["type"].(string)
		role, _ := obj["role"].(string)
		role = normalizeResponsesRole(role)
		if role == "" {
			if !responsesReadableItems[itemType] {
				return fmt.Sprintf("%s has type %q, which this proxy cannot read", fields[i], itemType)
			}
			if itemType != "" && itemType != "message" {
				continue
			}
		} else if role != "user" {
			continue
		}
		parts, _ := obj["content"].([]interface{})
		for j, part := range parts {
			if msg := unreadableType(fmt.Sprintf("%s.content[%d]", fields[i], j), part, openAIReadableParts); msg != "" {
				return msg
			}
		}
	}
	return ""
}

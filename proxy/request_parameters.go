package proxy

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// The decoder must not turn an unimplemented parameter into a successful
// request with different semantics. Native model extensions have an explicit
// pass-through field; unknown OpenAI/Anthropic options produce a named error.
func validateRequestParameters(body []byte, request interface{}) string {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return "Invalid JSON"
	}
	supported := map[string]bool{}
	typ := reflect.TypeOf(request).Elem()
	for i := 0; i < typ.NumField(); i++ {
		supported[strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]] = true
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if key == "max_tokens" || key == "max_completion_tokens" || key == "max_output_tokens" {
			var limit int
			if json.Unmarshal(fields[key], &limit) == nil && limit <= 0 {
				return key + " must be positive for a generation request"
			}
		}
		if supported[key] {
			continue
		}
		var value interface{}
		_ = json.Unmarshal(fields[key], &value)
		if value == nil {
			continue
		}
		// Interoperable aliases must agree, so accepting them cannot hide a
		// second, different user input or token limit.
		if key == "input" || key == "messages" {
			var input string
			var messages []struct {
				Role    string      `json:"role"`
				Content interface{} `json:"content"`
			}
			if json.Unmarshal(fields["input"], &input) == nil && json.Unmarshal(fields["messages"], &messages) == nil && len(messages) == 1 && messages[0].Role == "user" && messages[0].Content == input {
				continue
			}
		}
		if key == "max_tokens" {
			if responses, ok := request.(*OpenAIResponsesRequest); ok {
				var limit int
				if json.Unmarshal(fields[key], &limit) == nil && limit >= 0 {
					if responses.MaxOutputTokens != 0 && responses.MaxOutputTokens != limit {
						return "conflicting max_tokens and max_output_tokens"
					}
					responses.MaxOutputTokens = limit
					continue
				}
			}
		}
		// These values request the default behavior and require no emulation.
		switch key {
		case "store":
			if value == false {
				continue
			}
		case "service_tier":
			if value == "auto" {
				continue
			}
		case "stop", "stop_sequences":
			if list, ok := value.([]interface{}); ok && len(list) == 0 {
				continue
			}
		case "n":
			if value == float64(1) {
				continue
			}
		case "logprobs":
			if value == false {
				continue
			}
		case "frequency_penalty", "presence_penalty":
			if value == float64(0) {
				continue
			}
		case "parallel_tool_calls":
			if value == true {
				continue
			}
		}
		return fmt.Sprintf("unsupported parameter %q for the Kiro upstream; it was not forwarded (use additional_model_request_fields for native model options)", key)
	}
	return ""
}

func validateAdapterOptions(maxTokens int, temperature, topP *float64, context map[string]interface{}) string {
	if maxTokens < 0 {
		return "max_tokens must not be negative"
	}
	if temperature != nil && (*temperature < 0 || *temperature > 2) {
		return "temperature must be between 0 and 2"
	}
	if topP != nil && (*topP < 0 || *topP > 1) {
		return "top_p must be between 0 and 1"
	}
	for key := range context {
		switch key {
		case "editorState", "shellState", "gitState", "envState", "additionalContext":
		default:
			return "unsupported kiro_context field: " + key
		}
	}
	return ""
}

func validateAdapterContent(content interface{}, role string, claude bool) string {
	if content == nil {
		return ""
	}
	if _, ok := content.(string); ok {
		return ""
	}
	switch content.(type) {
	case map[string]interface{}, []interface{}:
	default:
		return "message content must be text or content blocks"
	}
	if list, ok := content.([]interface{}); ok && len(list) != len(adapterContentBlocks(content)) {
		return "each content block must be an object"
	}
	for _, block := range adapterContentBlocks(content) {
		if cache, ok := block["cache_control"].(map[string]interface{}); ok {
			if msg := validateAdapterCache(cache); msg != "" {
				return msg
			}
		}
		kind := firstString(block["type"])
		switch kind {
		case "text", "input_text", "output_text", "refusal":
			if _, ok := block["text"].(string); !ok && kind != "refusal" {
				return kind + " requires text"
			}
		case "image", "image_url", "input_image":
			if extractImageFromClaudeBlock(block) == nil {
				return "image requires valid inline base64 data; remote image URLs and file IDs are unsupported"
			}
		case "document", "file", "input_file":
			if extractImageFromOpenAIPart(block) == nil {
				if _, err := adapterDocument(block); err != nil {
					return err.Error()
				}
			}
		case "tool_result":
			if !claude || role != "user" {
				return "tool_result is only valid in a Claude user message"
			}
			if msg := validateAdapterContent(block["content"], "tool", claude); msg != "" {
				return msg
			}
			if firstString(block["tool_use_id"]) == "" {
				return "tool_result requires tool_use_id"
			}
		case "tool_use", "thinking", "redacted_thinking", "web_search_tool_result":
			if !claude || role != "assistant" {
				return kind + " is only valid in a Claude assistant message"
			}
			if kind == "tool_use" {
				if firstString(block["id"]) == "" || firstString(block["name"]) == "" {
					return "tool_use requires id and name"
				}
				if _, ok := block["input"].(map[string]interface{}); !ok {
					return "tool_use.input must be an object"
				}
			}
		case "":
			if nested, ok := block["content"]; ok {
				if msg := validateAdapterContent(nested, role, claude); msg != "" {
					return msg
				}
				continue
			}
			if _, ok := block["text"].(string); ok {
				continue
			}
			return "content block type is required"
		default:
			return "unsupported content block type: " + kind
		}
	}
	return ""
}

func validateAdapterCache(cache map[string]interface{}) string {
	if len(cache) == 0 {
		return ""
	}
	if cache["type"] != "ephemeral" {
		return "cache_control.type must be ephemeral"
	}
	if ttl, ok := cache["ttl"]; ok && ttl != "5m" && ttl != "1h" {
		return "cache_control.ttl must be 5m or 1h"
	}
	return ""
}

func validateChatResponseFormat(format map[string]interface{}) string {
	if len(format) == 0 {
		return ""
	}
	kind := firstString(format["type"])
	switch kind {
	case "text", "json_object":
		return ""
	case "json_schema":
		schema, _ := format["json_schema"].(map[string]interface{})
		if schema["strict"] == true {
			return "strict response_format.json_schema is unsupported by Kiro; non-strict JSON format uses a prompt instruction"
		}
		return ""
	default:
		return "unsupported response_format.type: " + kind
	}
}

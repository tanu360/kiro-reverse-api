package proxy

import (
	"fmt"
	"strings"
)

func (h *Handler) validateModelControls(model string, limit int, temperature, topP *float64, thinking *ClaudeThinkingConfig, output map[string]interface{}, fields map[string]interface{}) string {
	model, _ = ParseModelAndThinking(model, "-thinking")
	canonical := strings.ReplaceAll(model, "-5-5", "-5.5")
	maximum := 128000
	schema := h.adapterModelSchema(canonical)
	properties, _ := schema["properties"].(map[string]interface{})
	if len(properties) == 0 && canonical == "claude-opus-5.5" {
		// Cold-cache validation still rejects the experimentally verified native
		// bounds and enumerations before any generation request is sent.
		schema = map[string]interface{}{"additionalProperties": false, "properties": map[string]interface{}{
			"max_tokens":    map[string]interface{}{"type": "integer", "minimum": float64(1024), "maximum": float64(128000)},
			"thinking":      map[string]interface{}{"type": "object", "properties": map[string]interface{}{"type": map[string]interface{}{"type": "string", "enum": []interface{}{"adaptive"}}, "display": map[string]interface{}{"type": "string", "enum": []interface{}{"summarized", "omitted"}}}},
			"output_config": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"effort": map[string]interface{}{"type": "string", "enum": []interface{}{"low", "medium", "high", "xhigh", "max"}}}},
		}}
		properties = schema["properties"].(map[string]interface{})
	}
	if native, ok := properties["max_tokens"].(map[string]interface{}); ok {
		if n, ok := native["maximum"].(float64); ok {
			maximum = int(n)
		}
	}
	if limit > maximum {
		return fmt.Sprintf("max_tokens exceeds the Kiro model maximum of %d", maximum)
	}
	for key := range output {
		if key != "effort" {
			return "output_config." + key + " is unsupported by the Kiro upstream; strict structured output cannot be guaranteed"
		}
	}
	if effort, ok := output["effort"]; ok {
		if effort != "low" && effort != "medium" && effort != "high" && effort != "xhigh" && effort != "max" {
			return "output_config.effort must be low, medium, high, xhigh or max"
		}
	}
	if outputSchema, ok := properties["output_config"].(map[string]interface{}); ok && len(output) > 0 {
		if msg := validateNativeFields(output, outputSchema, "output_config"); msg != "" {
			return msg
		}
	}
	if canonical == "claude-opus-5.5" {
		if temperature != nil && *temperature != 1 {
			return "temperature is unsupported for Claude Opus 5.5; omit it or use the default 1"
		}
		if topP != nil && *topP < 0.99 {
			return "top_p is unsupported for Claude Opus 5.5; omit it or use a compatible default of at least 0.99"
		}
		if thinking != nil && (thinking.Type == "enabled" || thinking.Type == "disabled") {
			return "Claude Opus 5.5 requires adaptive thinking and does not support thinking budgets or disabled thinking"
		}
	}
	if output, ok := fields["output_config"].(map[string]interface{}); ok {
		for key := range output {
			if key != "effort" {
				return "additional_model_request_fields.output_config." + key + " is unsupported by the Kiro upstream"
			}
		}
	}
	if len(properties) > 0 && len(fields) > 0 {
		return validateNativeFields(fields, schema, "additional_model_request_fields")
	}
	return ""
}

func validateNativeFields(fields map[string]interface{}, schema map[string]interface{}, path string) string {
	properties, _ := schema["properties"].(map[string]interface{})
	for key, value := range fields {
		entry, known := properties[key].(map[string]interface{})
		if !known {
			if schema["additionalProperties"] == false || len(properties) > 0 {
				return path + "." + key + " is unsupported by the Kiro model"
			}
			continue
		}
		p := path + "." + key
		switch entry["type"] {
		case "object":
			if _, ok := value.(map[string]interface{}); !ok {
				return p + " must be an object"
			}
		case "string":
			if _, ok := value.(string); !ok {
				return p + " must be a string"
			}
		}
		if enums, ok := entry["enum"].([]interface{}); ok {
			valid := false
			for _, v := range enums {
				if v == value {
					valid = true
				}
			}
			if !valid {
				return p + " has an unsupported value"
			}
		}
		if entry["type"] == "integer" {
			n, ok := value.(float64)
			if !ok || n != float64(int(n)) {
				return p + " must be an integer"
			}
			if lo, ok := entry["minimum"].(float64); ok && n < lo {
				return fmt.Sprintf("%s must be at least %.0f", p, lo)
			}
			if hi, ok := entry["maximum"].(float64); ok && n > hi {
				return fmt.Sprintf("%s must not exceed %.0f", p, hi)
			}
		}
		if nested, ok := value.(map[string]interface{}); ok {
			if required, ok := entry["required"].([]interface{}); ok {
				for _, name := range required {
					if key, ok := name.(string); ok && nested[key] == nil {
						return p + "." + key + " is required"
					}
				}
			}
			if msg := validateNativeFields(nested, entry, p); msg != "" {
				return msg
			}
		}
	}
	return ""
}

func validateClaudeToolPairs(messages []ClaudeMessage) string {
	pending := map[string]bool{}
	seen := map[string]bool{}
	for _, message := range messages {
		// Claude Code can append instructions between tool_use and tool_result.
		// They neither consume nor clear the outstanding tool IDs.
		if message.Role == "system" {
			continue
		}
		results := map[string]bool{}
		uses := map[string]bool{}
		for _, block := range adapterContentBlocks(message.Content) {
			switch block["type"] {
			case "tool_use":
				id := firstString(block["id"])
				if seen[id] {
					return "duplicate tool_use id: " + id
				}
				seen[id] = true
				uses[id] = true
			case "tool_result":
				id := firstString(block["tool_use_id"])
				if !pending[id] || results[id] {
					return "tool_result.tool_use_id must match an outstanding tool_use in the preceding assistant turn: " + id
				}
				results[id] = true
			}
		}
		if len(pending) > 0 {
			if message.Role != "user" || len(results) != len(pending) {
				return "all tool_use blocks require a tool_result in the next user message"
			}
		}
		pending = uses
	}
	if len(pending) > 0 {
		return "missing tool_result for the preceding tool_use"
	}
	return ""
}

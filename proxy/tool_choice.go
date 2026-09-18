package proxy

import (
	"encoding/json"
	"strings"
)

func claudeToolChoice(value interface{}) (string, string) {
	if value == nil {
		return "auto", ""
	}
	if text, ok := value.(string); ok {
		return strings.ToLower(strings.TrimSpace(text)), ""
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "invalid", ""
	}
	var choice struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &choice) != nil {
		return "invalid", ""
	}
	return strings.ToLower(strings.TrimSpace(choice.Type)), strings.TrimSpace(choice.Name)
}

func validateClaudeToolChoice(req *ClaudeRequest) string {
	kind, name := claudeToolChoice(req.ToolChoice)
	switch kind {
	case "auto", "none":
		return ""
	case "any":
		if len(req.Tools) > 0 {
			return ""
		}
		return "tool_choice any requires tools"
	case "tool":
		for _, tool := range req.Tools {
			if name != "" && tool.Name == name {
				return ""
			}
		}
		return "tool_choice names an undeclared tool"
	default:
		return "unsupported tool_choice type"
	}
}

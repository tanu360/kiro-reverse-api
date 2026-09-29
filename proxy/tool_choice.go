package proxy

import (
	"encoding/json"
	"fmt"
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

// openAIToolChoice maps Chat Completions and Responses tool_choice onto the
// Claude kinds the translators enforce: auto, none, any or tool.
func openAIToolChoice(value interface{}) (string, string) {
	if value == nil {
		return "auto", ""
	}
	if text, ok := value.(string); ok {
		switch choice := strings.ToLower(strings.TrimSpace(text)); choice {
		case "", "auto":
			return "auto", ""
		case "required":
			return "any", ""
		default:
			return choice, ""
		}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "invalid", ""
	}
	// Chat Completions nests the name under function; Responses puts it at the top.
	var choice struct {
		Type     string `json:"type"`
		Name     string `json:"name"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &choice) != nil {
		return "invalid", ""
	}
	switch strings.ToLower(strings.TrimSpace(choice.Type)) {
	case "function", "custom":
	default:
		//! Other object forms (allowed_tools, hosted tools) were always ignored; keep that.
		return "auto", ""
	}
	name := strings.TrimSpace(choice.Function.Name)
	if name == "" {
		name = strings.TrimSpace(choice.Name)
	}
	return "tool", name
}

func validateOpenAIToolChoice(req *OpenAIRequest) string {
	kind, name := openAIToolChoice(req.ToolChoice)
	switch kind {
	case "auto", "none":
		return ""
	case "any":
		if len(req.Tools) > 0 {
			return ""
		}
		return "tool_choice required requires tools"
	case "tool":
		for _, tool := range req.Tools {
			if name != "" && tool.Function.Name == name {
				return ""
			}
		}
		return "tool_choice names an undeclared tool"
	default:
		return "unsupported tool_choice"
	}
}

// toolChoiceDirective tells the model a tool call is mandatory. Kiro has no
// tool_choice field, so the requirement rides in the user turn.
func toolChoiceDirective(kind, toolName string) string {
	switch kind {
	case "any":
		return "The client requires a tool call on this turn. Call at least one available tool."
	case "tool":
		return fmt.Sprintf("The client requires the tool %q on this turn. Call that tool.", toolName)
	default:
		return ""
	}
}

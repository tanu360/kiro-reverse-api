package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

type responsesToolIdentity struct {
	Name, Namespace, Type string
}

func extractAdditionalResponsesTools(raw json.RawMessage) ([]OpenAIResponsesTool, error) {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		var item map[string]interface{}
		if json.Unmarshal(raw, &item) != nil {
			return nil, nil
		}
		items = []json.RawMessage{raw}
	}
	var tools []OpenAIResponsesTool
	for _, item := range items {
		var header struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(item, &header) != nil || header.Type != "additional_tools" {
			continue
		}
		var block struct {
			Tools []OpenAIResponsesTool `json:"tools"`
		}
		if err := json.Unmarshal(item, &block); err != nil {
			return nil, fmt.Errorf("invalid additional_tools: %w", err)
		}
		if block.Tools == nil {
			return nil, fmt.Errorf("additional_tools requires a tools array")
		}
		tools = append(tools, block.Tools...)
	}
	return tools, nil
}

func responsesToolIdentities(tools []OpenAIResponsesTool) (map[string]responsesToolIdentity, error) {
	result := make(map[string]responsesToolIdentity)
	var conflict error
	var walk func([]OpenAIResponsesTool, string)
	walk = func(tools []OpenAIResponsesTool, namespace string) {
		for _, tool := range tools {
			kind := strings.ToLower(strings.TrimSpace(tool.Type))
			if kind == "namespace" {
				walk(tool.Tools, qualifiedResponsesToolName(namespace, tool.Name))
				continue
			}
			if kind == "" && tool.Function.Name != "" {
				kind = "function"
			}
			if kind != "function" && kind != "custom" {
				continue
			}
			name := strings.TrimSpace(firstNonEmpty(tool.Function.Name, tool.Name))
			key := qualifiedResponsesToolName(namespace, name)
			identity := responsesToolIdentity{Name: name, Namespace: namespace, Type: kind}
			if prior, exists := result[key]; exists && prior != identity {
				conflict = fmt.Errorf("ambiguous Responses tool identity: %s", key)
			}
			result[key] = identity
		}
	}
	walk(tools, "")
	return result, conflict
}

func buildPreparedResponsesToolOutputItem(prepared *responsesPreparedRequest, tu KiroToolUse) map[string]interface{} {
	item := buildResponsesToolOutputItem(tu)
	identity, ok := prepared.ToolIdentities[tu.Name]
	if !ok {
		return item
	}
	item["name"] = identity.Name
	if identity.Namespace != "" {
		item["namespace"] = identity.Namespace
	}
	if identity.Type == "custom" {
		item["type"] = "custom_tool_call"
		item["input"], _ = tu.Input["input"].(string)
		delete(item, "arguments")
	}
	return item
}

// customToolDescription carries a custom tool's grammar into its description.
// Kiro only takes a JSON schema, so without this the model never sees the
// exact input syntax (Codex's freeform apply_patch declares a Lark grammar).
func customToolDescription(tool OpenAIResponsesTool) string {
	description := strings.TrimSpace(tool.Description)
	if strings.ToLower(firstString(tool.Format["type"])) != "grammar" {
		return description
	}
	definition := strings.TrimSpace(firstString(tool.Format["definition"]))
	if definition == "" {
		return description
	}
	grammar := "grammar"
	if syntax := strings.TrimSpace(firstString(tool.Format["syntax"])); syntax != "" {
		grammar = syntax + " grammar"
	}
	hint := "The input string must match this " + grammar + ":\n" + definition
	if description == "" {
		return hint
	}
	return description + "\n\n" + hint
}

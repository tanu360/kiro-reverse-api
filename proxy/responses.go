package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

type OpenAIResponsesRequest struct {
	Model              string                 `json:"model"`
	Input              json.RawMessage        `json:"input"`
	Instructions       interface{}            `json:"instructions,omitempty"`
	PreviousResponseID string                 `json:"previous_response_id,omitempty"`
	Stream             bool                   `json:"stream,omitempty"`
	MaxOutputTokens    int                    `json:"max_output_tokens,omitempty"`
	Temperature        float64                `json:"temperature,omitempty"`
	TopP               float64                `json:"top_p,omitempty"`
	Tools              []OpenAIResponsesTool  `json:"tools,omitempty"`
	ToolChoice         interface{}            `json:"tool_choice,omitempty"`
	Text               *OpenAIResponsesText   `json:"text,omitempty"`
	Store              *bool                  `json:"store,omitempty"`
	Metadata           map[string]interface{} `json:"metadata,omitempty"`
}

type OpenAIResponsesText struct {
	Format map[string]interface{} `json:"format,omitempty"`
}

type OpenAIResponsesTool struct {
	Type        string                `json:"type"`
	Name        string                `json:"name,omitempty"`
	Description string                `json:"description,omitempty"`
	Parameters  interface{}           `json:"parameters,omitempty"`
	Tools       []OpenAIResponsesTool `json:"tools,omitempty"`
	Function    struct {
		Name        string      `json:"name"`
		Description string      `json:"description,omitempty"`
		Parameters  interface{} `json:"parameters,omitempty"`
	} `json:"function,omitempty"`
}

type responsesPreparedRequest struct {
	OpenAIRequest    OpenAIRequest
	CurrentMessages  []OpenAIMessage
	StoredMessages   []OpenAIMessage
	Store            bool
	Metadata         map[string]interface{}
	PreviousResponse string
}

func prepareResponsesRequest(req *OpenAIResponsesRequest, previous []OpenAIMessage) (*responsesPreparedRequest, string) {
	if strings.TrimSpace(req.Model) == "" {
		return nil, "model is required"
	}
	if msg := validateResponsesTextFormat(req.Text); msg != "" {
		return nil, msg
	}

	tools, msg := convertResponsesTools(req.Tools, req.ToolChoice)
	if msg != "" {
		return nil, msg
	}

	currentMessages, err := responsesInputToMessages(req.Input)
	if err != nil {
		return nil, err.Error()
	}
	if len(currentMessages) == 0 {
		return nil, "input is required"
	}

	messagesForKiro := make([]OpenAIMessage, 0, len(previous)+len(currentMessages)+1)
	messagesForKiro = append(messagesForKiro, previous...)
	if instructionText := strings.TrimSpace(extractOpenAIMessageText(responsesContentToOpenAIContent(req.Instructions))); instructionText != "" {
		messagesForKiro = append(messagesForKiro, OpenAIMessage{Role: "system", Content: instructionText})
	}
	messagesForKiro = append(messagesForKiro, currentMessages...)

	openaiReq := OpenAIRequest{
		Model:       req.Model,
		Messages:    messagesForKiro,
		MaxTokens:   req.MaxOutputTokens,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stream:      req.Stream,
		Tools:       tools,
	}
	if msg := validateOpenAIRequestShape(&openaiReq); msg != "" {
		return nil, msg
	}

	store := true
	if req.Store != nil {
		store = *req.Store
	}

	storedMessages := make([]OpenAIMessage, 0, len(previous)+len(currentMessages))
	storedMessages = append(storedMessages, previous...)
	storedMessages = append(storedMessages, currentMessages...)

	return &responsesPreparedRequest{
		OpenAIRequest:    openaiReq,
		CurrentMessages:  currentMessages,
		StoredMessages:   storedMessages,
		Store:            store,
		Metadata:         req.Metadata,
		PreviousResponse: req.PreviousResponseID,
	}, ""
}

func validateResponsesTextFormat(text *OpenAIResponsesText) string {
	if text == nil || len(text.Format) == 0 {
		return ""
	}
	formatType, _ := text.Format["type"].(string)
	if formatType == "" || formatType == "text" {
		return ""
	}
	return "unsupported text.format type: " + formatType
}

func convertResponsesTools(tools []OpenAIResponsesTool, toolChoice interface{}) ([]OpenAITool, string) {
	if msg := validateResponsesToolChoice(toolChoice); msg != "" {
		return nil, msg
	}
	if choice, ok := toolChoice.(string); ok && strings.ToLower(strings.TrimSpace(choice)) == "none" {
		return nil, ""
	}

	result := make([]OpenAITool, 0, len(tools))
	for _, tool := range tools {
		converted, msg := convertResponsesTool(tool)
		if msg != "" {
			return nil, msg
		}
		result = append(result, converted...)
	}
	return result, ""
}

func convertResponsesTool(tool OpenAIResponsesTool) ([]OpenAITool, string) {
	toolType := strings.ToLower(strings.TrimSpace(tool.Type))
	if toolType == "" && tool.Function.Name != "" {
		toolType = "function"
	}

	if toolType == "namespace" {
		result := make([]OpenAITool, 0, len(tool.Tools))
		for _, child := range tool.Tools {
			converted, msg := convertResponsesTool(child)
			if msg != "" {
				return nil, msg
			}
			result = append(result, converted...)
		}
		return result, ""
	}

	var name, description string
	var parameters interface{}
	switch toolType {
	case "function":
		name = firstNonEmpty(tool.Function.Name, tool.Name)
		description = firstNonEmpty(tool.Function.Description, tool.Description)
		parameters = tool.Function.Parameters
		if parameters == nil {
			parameters = tool.Parameters
		}
	case "custom":
		name = tool.Name
		description = tool.Description
		parameters = tool.Parameters
	default:
		return nil, ""
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return nil, "Responses tool name is required"
	}
	if parameters == nil {
		parameters = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
	}

	var converted OpenAITool
	converted.Type = "function"
	converted.Function.Name = name
	converted.Function.Description = description
	converted.Function.Parameters = parameters
	return []OpenAITool{converted}, ""
}

func validateResponsesToolChoice(toolChoice interface{}) string {
	if toolChoice == nil {
		return ""
	}
	switch choice := toolChoice.(type) {
	case string:
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "", "auto", "none", "required":
			return ""
		default:
			return "unsupported tool_choice: " + choice
		}
	default:
		return ""
	}
}

func responsesInputToMessages(raw json.RawMessage) ([]OpenAIMessage, error) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "" || string(raw) == "null" {
		return nil, nil
	}

	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if strings.TrimSpace(text) == "" {
			return nil, nil
		}
		return []OpenAIMessage{{Role: "user", Content: text}}, nil
	}

	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err == nil {
		var messages []OpenAIMessage
		for _, item := range arr {
			itemMessages, err := responseInputItemToMessages(item)
			if err != nil {
				return nil, err
			}
			messages = append(messages, itemMessages...)
		}
		return messages, nil
	}

	var obj map[string]interface{}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return responseInputItemToMessages(obj)
	}

	return nil, fmt.Errorf("input must be a string or array")
}

func responseInputItemToMessages(item interface{}) ([]OpenAIMessage, error) {
	obj, ok := item.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("input item must be an object")
	}

	itemType, _ := obj["type"].(string)
	role, _ := obj["role"].(string)
	role = normalizeResponsesRole(role)

	switch itemType {
	case "", "message":
		if role == "" {
			role = "user"
		}
		return []OpenAIMessage{{Role: role, Content: responsesContentToOpenAIContent(obj["content"])}}, nil
	case "input_text":
		return []OpenAIMessage{{Role: "user", Content: responseTextFromItem(obj)}}, nil
	case "output_text":
		return []OpenAIMessage{{Role: "assistant", Content: responseTextFromItem(obj)}}, nil
	case "function_call_output":
		callID := firstString(obj["call_id"], obj["tool_call_id"], obj["id"])
		return []OpenAIMessage{{Role: "tool", ToolCallID: callID, Content: responsesContentToOpenAIContent(firstExisting(obj, "output", "content"))}}, nil
	case "function_call":
		callID := firstString(obj["call_id"], obj["id"])
		name := firstString(obj["name"])
		arguments := firstString(obj["arguments"])
		if arguments == "" {
			if rawArgs, ok := obj["arguments"]; ok {
				if b, err := json.Marshal(rawArgs); err == nil {
					arguments = string(b)
				}
			}
		}
		tc := ToolCall{ID: callID, Type: "function"}
		tc.Function.Name = name
		tc.Function.Arguments = arguments
		return []OpenAIMessage{{Role: "assistant", Content: nil, ToolCalls: []ToolCall{tc}}}, nil
	default:
		if role != "" {
			return []OpenAIMessage{{Role: role, Content: responsesContentToOpenAIContent(obj["content"])}}, nil
		}
		if strings.TrimSpace(itemType) != "" {
			return nil, nil
		}
		return nil, fmt.Errorf("unsupported Responses input item type: %s", itemType)
	}
}

func responsesContentToOpenAIContent(content interface{}) interface{} {
	switch value := content.(type) {
	case nil:
		return nil
	case string:
		return value
	case []interface{}:
		parts := make([]interface{}, 0, len(value))
		for _, part := range value {
			parts = append(parts, responsesContentPartToOpenAI(part))
		}
		return parts
	case map[string]interface{}:
		return responsesContentPartToOpenAI(value)
	default:
		return value
	}
}

func responsesContentPartToOpenAI(part interface{}) interface{} {
	obj, ok := part.(map[string]interface{})
	if !ok {
		return part
	}
	partType, _ := obj["type"].(string)
	switch partType {
	case "input_text", "output_text":
		return map[string]interface{}{"type": "text", "text": responseTextFromItem(obj)}
	case "refusal":
		return map[string]interface{}{"type": "text", "text": responseTextFromItem(obj)}
	default:
		return obj
	}
}

func normalizeResponsesRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "developer", "system":
		return "system"
	case "assistant", "tool", "user":
		return strings.ToLower(strings.TrimSpace(role))
	default:
		return strings.ToLower(strings.TrimSpace(role))
	}
}

func responseTextFromItem(obj map[string]interface{}) string {
	return firstString(obj["text"], obj["content"], obj["output"])
}

func firstExisting(obj map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := obj[key]; ok {
			return value
		}
	}
	return nil
}

func firstString(values ...interface{}) string {
	for _, value := range values {
		if s, ok := value.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

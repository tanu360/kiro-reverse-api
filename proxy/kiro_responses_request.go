package proxy

import (
	"encoding/json"
	"strings"
)

//! CreateResponse (POST /v1/responses) takes the conversation the Kiro IDE builds for
//! generateAssistantResponse, rewritten as OpenAI Responses-style input items (the IDE's
//! buildCreateResponseRequest). There is no max token or temperature setting, and the system
//! text stays at the head of the first user message, as in generateAssistantResponse.

// kiroResponsesRequest is a CreateResponse request body.
type kiroResponsesRequest struct {
	Model      string                   `json:"model"`
	Input      []map[string]interface{} `json:"input"`
	Tools      []kiroResponsesTool      `json:"tools,omitempty"`
	Stream     bool                     `json:"stream"`
	Origin     string                   `json:"origin"`
	ProfileArn string                   `json:"profileArn,omitempty"`
	Metadata   map[string]string        `json:"metadata,omitempty"`
	Reasoning  map[string]string        `json:"reasoning,omitempty"`
}

type kiroResponsesTool struct {
	Type        string      `json:"type"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
}

// documentMediaTypes maps a Kiro document format back to its media type.
var documentMediaTypes = func() map[string]string {
	out := make(map[string]string, len(documentFormatsByMediaType))
	for media, format := range documentFormatsByMediaType {
		out[format] = media
	}
	return out
}()

// buildKiroResponsesRequest rewrites a generateAssistantResponse payload as a CreateResponse
// body: every history entry and then the current message as input items, the current
// message's tools as functions, and the conversation ids as metadata.
func buildKiroResponsesRequest(payload *KiroPayload) *kiroResponsesRequest {
	state := &payload.ConversationState
	current := &state.CurrentMessage.UserInputMessage
	origin := current.Origin
	if origin == "" {
		origin = "AI_EDITOR"
	}
	req := &kiroResponsesRequest{
		Model:      current.ModelID,
		Input:      []map[string]interface{}{},
		Stream:     true,
		Origin:     origin,
		ProfileArn: payload.ProfileArn,
		Metadata:   map[string]string{"kiro:agent_mode": "vibe"},
		Reasoning:  kiroResponsesReasoning(payload.AdditionalModelRequestFields),
	}
	if state.ConversationID != "" {
		req.Metadata["kiro:conversation_id"] = state.ConversationID
	}
	if state.AgentContinuationId != "" {
		req.Metadata["kiro:agent_continuation_id"] = state.AgentContinuationId
	}
	for i := range state.History {
		entry := &state.History[i]
		if entry.UserInputMessage != nil {
			req.Input = append(req.Input, responsesUserItems(entry.UserInputMessage)...)
		}
		if entry.AssistantResponseMessage != nil {
			req.Input = append(req.Input, responsesAssistantItems(entry.AssistantResponseMessage)...)
		}
	}
	req.Input = append(req.Input, responsesUserItems(current)...)
	if ctx := current.UserInputMessageContext; ctx != nil {
		for _, tool := range ctx.Tools {
			spec := tool.ToolSpecification
			if spec.Name == "" {
				continue
			}
			req.Tools = append(req.Tools, kiroResponsesTool{
				Type:        "function",
				Name:        spec.Name,
				Description: spec.Description,
				Parameters:  spec.InputSchema.JSON,
			})
		}
	}
	return req
}

// kiroResponsesReasoning is the IDE's buildReasoningField: the thinking type, the effort and
// how the reasoning is shown, from the generateAssistantResponse model fields. A thinking
// budget has no place in it.
func kiroResponsesReasoning(fields map[string]interface{}) map[string]string {
	if len(fields) == 0 {
		return nil
	}
	nested := func(parent, key string) string {
		m, _ := fields[parent].(map[string]interface{})
		s, _ := m[key].(string)
		return strings.TrimSpace(s)
	}
	out := map[string]string{}
	if v := nested("thinking", "type"); v != "" {
		out["type"] = v
	}
	effort := nested("output_config", "effort")
	if effort == "" {
		effort = nested("reasoning", "effort")
	}
	if effort != "" {
		out["effort"] = effort
	}
	if v := nested("thinking", "display"); v != "" {
		out["summary"] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// responsesUserItems is a user turn as input items: its tool results first, then what the user
// wrote, as a string or, with images or documents, as a list of parts.
func responsesUserItems(msg *KiroUserInputMessage) []map[string]interface{} {
	var items []map[string]interface{}
	var toolResults []KiroToolResult
	if ctx := msg.UserInputMessageContext; ctx != nil {
		toolResults = ctx.ToolResults
		for _, result := range ctx.ToolResults {
			parts := make([]string, 0, len(result.Content))
			for _, c := range result.Content {
				parts = append(parts, c.Text)
			}
			items = append(items, map[string]interface{}{
				"type":    "function_call_output",
				"call_id": result.ToolUseID,
				"output":  strings.Join(parts, "\n"),
			})
		}
	}

	text := msg.Content
	//! generateAssistantResponse wants text in every user turn, so the translator repeats the
	//! tool results there (buildToolResultsContinuation) or puts a stand-in. The
	//! function_call_output items already carry them; only text the client wrote stays.
	if len(toolResults) > 0 {
		text = withoutTextBlock(text, buildToolResultsContinuation(toolResults))
		if strings.TrimSpace(text) == minimalFallbackUserContent {
			text = ""
		}
	}
	var parts []map[string]interface{}
	for _, img := range msg.Images {
		if img.Source.Bytes == "" {
			continue
		}
		parts = append(parts, map[string]interface{}{
			"type":      "input_image",
			"image_url": "data:image/" + strings.ToLower(strings.TrimSpace(img.Format)) + ";base64," + img.Source.Bytes,
		})
	}
	for _, doc := range msg.Documents {
		if doc.Source.Bytes == "" {
			continue
		}
		media := documentMediaTypes[strings.ToLower(doc.Format)]
		if media == "" {
			media = "application/octet-stream"
		}
		filename := doc.Name
		if filename == "" {
			filename = "document"
		}
		if doc.Format != "" {
			filename += "." + strings.ToLower(doc.Format)
		}
		parts = append(parts, map[string]interface{}{
			"type":      "input_file",
			"filename":  filename,
			"file_data": "data:" + media + ";base64," + doc.Source.Bytes,
		})
	}
	switch {
	case len(parts) > 0:
		content := make([]map[string]interface{}, 0, len(parts)+1)
		if text != "" {
			content = append(content, map[string]interface{}{"type": "input_text", "text": text})
		}
		items = append(items, map[string]interface{}{"role": "user", "content": append(content, parts...)})
	case text != "":
		items = append(items, map[string]interface{}{"role": "user", "content": text})
	}
	return items
}

// withoutTextBlock takes block out of text, where joinHistoryText put it after the client's
// text and before any directive, and joins what is left the same way.
func withoutTextBlock(text, block string) string {
	//! joinHistoryText trimmed the block when it put it in.
	block = strings.TrimSpace(block)
	//! The last copy is the one joinHistoryText appended; client text quoting it stays.
	idx := strings.LastIndex(text, block)
	if idx < 0 {
		return text
	}
	return joinHistoryText(text[:idx], text[idx+len(block):])
}

// responsesAssistantItems is an assistant turn as input items: its reasoning, its text, then
// its tool calls with their arguments as a JSON string.
func responsesAssistantItems(msg *KiroAssistantResponseMessage) []map[string]interface{} {
	var items []map[string]interface{}
	content := msg.Content
	for _, block := range msg.Reasoning {
		envelope := map[string]interface{}{}
		switch {
		case block.RedactedContent != "":
			envelope["redactedContent"] = block.RedactedContent
		case block.Signature != "":
			envelope["reasoningText"] = map[string]string{"text": block.Text, "signature": block.Signature}
			//! The thinking went to generateAssistantResponse as <thinking> text in the content;
			//! here it travels as reasoning, so it must not appear twice.
			content = removeThinkingSegment(content, block.Text)
		default:
			continue
		}
		encoded, _ := json.Marshal(envelope)
		items = append(items, map[string]interface{}{
			"type":              "reasoning",
			"summary":           []interface{}{},
			"encrypted_content": string(encoded),
		})
	}
	if strings.TrimSpace(content) != "" {
		items = append(items, map[string]interface{}{"role": "assistant", "content": content})
	}
	for _, tu := range msg.ToolUses {
		input := tu.Input
		if input == nil {
			input = map[string]interface{}{}
		}
		arguments, _ := json.Marshal(input)
		items = append(items, map[string]interface{}{
			"type":      "function_call",
			"call_id":   tu.ToolUseID,
			"name":      tu.Name,
			"arguments": string(arguments),
		})
	}
	return items
}

// removeThinkingSegment takes one <thinking>text</thinking> segment, and the blank line that
// joined it to the next, out of assistant content.
func removeThinkingSegment(content, text string) string {
	segment := thinkingOpenTag + text + thinkingCloseTag
	idx := strings.Index(content, segment)
	if idx < 0 {
		return content
	}
	rest := strings.TrimPrefix(content[idx+len(segment):], "\n\n")
	return content[:idx] + rest
}

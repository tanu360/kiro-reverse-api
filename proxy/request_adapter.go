package proxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/google/uuid"
)

// Protocol adapters feed this builder. Size limits belong to the HTTP/upstream
// boundary; this layer never budgets, slices, or deduplicates client content.
type adapterRequest struct {
	Model, System, ConversationID, Anchor, ToolChoice string
	SystemCache                                       *KiroCachePoint
	Messages                                          []KiroHistoryMessage
	Tools                                             []KiroToolWrapper
	ToolNames                                         map[string]string
	Inference                                         *InferenceConfig
	Context, AdditionalFields, OutputConfig           map[string]interface{}
	SerialTools                                       bool
	LegacyThinking                                    bool
}

type KiroCachePoint struct {
	Type string `json:"type"`
}

func (tool KiroToolWrapper) MarshalJSON() ([]byte, error) {
	if tool.CachePoint != nil {
		return json.Marshal(struct {
			CachePoint *KiroCachePoint `json:"cachePoint"`
		}{tool.CachePoint})
	}
	type wireTool KiroToolWrapper
	return json.Marshal(wireTool(tool))
}

type KiroDocument struct {
	Format string `json:"format"`
	Name   string `json:"name"`
	Source struct {
		Bytes string `json:"bytes"`
	} `json:"source"`
}

func newAdapterUser(text string, images []KiroImage, documents []KiroDocument, model string) *KiroUserInputMessage {
	return &KiroUserInputMessage{Content: text, ModelID: model, Origin: "AI_EDITOR", Images: images, Documents: documents}
}

func adapterInference(maxTokens int, temperature, topP *float64) *InferenceConfig {
	if maxTokens == 0 && temperature == nil && topP == nil {
		return nil
	}
	return &InferenceConfig{MaxTokens: maxTokens, Temperature: temperature, TopP: topP}
}

func buildAdapterPayload(req adapterRequest) *KiroPayload {
	history := req.Messages
	current := newAdapterUser("", nil, nil, req.Model)
	if len(history) > 0 && history[len(history)-1].UserInputMessage != nil {
		current = history[len(history)-1].UserInputMessage
		history = history[:len(history)-1]
	}
	if req.System != "" {
		priming := []KiroHistoryMessage{
			{UserInputMessage: newAdapterUser(req.System, nil, nil, req.Model)},
			{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "I will follow these instructions."}},
		}
		priming[0].UserInputMessage.CachePoint = req.SystemCache
		history = append(priming, history...)
	}
	var results []KiroToolResult
	if current.UserInputMessageContext != nil {
		results = current.UserInputMessageContext.ToolResults
	}
	choice := req.ToolChoice
	if len(req.Tools) == 0 {
		choice = "none"
	}
	history, text, keep := attachCurrentToolResults(history, current.Content, results, choice)
	current.Content = text
	if !keep && current.UserInputMessageContext != nil {
		current.UserInputMessageContext.ToolResults = nil
	}
	if current.Content == "" {
		if len(current.Images) > 0 {
			current.Content = normalizeUserContent("", true)
		} else {
			current.Content = minimalFallbackUserContent
		}
	}
	if len(req.Tools) > 0 || len(req.Context) > 0 {
		if current.UserInputMessageContext == nil {
			current.UserInputMessageContext = &UserInputMessageContext{}
		}
		ctx := current.UserInputMessageContext
		ctx.Tools = req.Tools
		ctx.EditorState = req.Context["editorState"]
		ctx.ShellState = req.Context["shellState"]
		ctx.GitState = req.Context["gitState"]
		ctx.EnvState = req.Context["envState"]
		ctx.AdditionalContext = req.Context["additionalContext"]
	}
	if len(req.Tools) > 0 && (req.ToolChoice == "any" || req.ToolChoice == "tool") {
		current.Content = joinHistoryText(current.Content, toolChoiceDirective(req.ToolChoice, req.Tools[0].ToolSpecification.Name))
	}
	if req.SerialTools && len(req.Tools) > 0 {
		current.Content = joinHistoryText(current.Content, "The client requests at most one tool call in each response. Wait for its result before making the next call.")
	}
	// Translate tool names consistently for definitions AND active history.
	inverse := make(map[string]string)
	for wire, original := range req.ToolNames {
		inverse[original] = wire
	}
	for _, message := range history {
		if message.AssistantResponseMessage != nil {
			for i := range message.AssistantResponseMessage.ToolUses {
				use := &message.AssistantResponseMessage.ToolUses[i]
				if wire := inverse[use.Name]; wire != "" {
					use.Name = wire
				}
			}
		}
	}
	// Kiro requires alternating roles. Insert protocol acknowledgements instead
	// of dropping leading assistant turns or repeated user messages.
	all := append(history, KiroHistoryMessage{UserInputMessage: current})
	all = alternateAdapterMessages(all, req.Model)
	payload := &KiroPayload{ToolNameMap: req.ToolNames, InferenceConfig: req.Inference, LegacyThinkingPrompt: req.LegacyThinking}
	state := &payload.ConversationState
	state.ChatTriggerType = "MANUAL"
	state.AgentTaskType = "vibe"
	state.AgentContinuationId = uuid.New().String()
	state.ConversationID = req.ConversationID
	if state.ConversationID == "" {
		state.ConversationID = buildConversationID(req.Model, req.System, req.Anchor)
	}
	state.CurrentMessage.UserInputMessage = *all[len(all)-1].UserInputMessage
	state.History = all[:len(all)-1]
	if len(req.AdditionalFields) > 0 {
		payload.AdditionalModelRequestFields = cloneSchemaMap(req.AdditionalFields)
	}
	if len(req.OutputConfig) > 0 {
		if payload.AdditionalModelRequestFields == nil {
			payload.AdditionalModelRequestFields = map[string]interface{}{}
		}
		output, _ := payload.AdditionalModelRequestFields["output_config"].(map[string]interface{})
		if output == nil {
			output = map[string]interface{}{}
		}
		for k, v := range req.OutputConfig {
			output[k] = cloneSchemaValue(v)
		}
		payload.AdditionalModelRequestFields["output_config"] = output
	}
	return payload
}

func alternateAdapterMessages(messages []KiroHistoryMessage, model string) []KiroHistoryMessage {
	result := make([]KiroHistoryMessage, 0, len(messages)+2)
	for _, message := range messages {
		if len(result) == 0 && message.AssistantResponseMessage != nil {
			result = append(result, KiroHistoryMessage{UserInputMessage: newAdapterUser(minimalFallbackUserContent, nil, nil, model)})
		}
		if len(result) > 0 {
			last := result[len(result)-1]
			if last.UserInputMessage != nil && message.UserInputMessage != nil {
				result = append(result, KiroHistoryMessage{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: "I understand."}})
			} else if last.AssistantResponseMessage != nil && message.AssistantResponseMessage != nil {
				result = append(result, KiroHistoryMessage{UserInputMessage: newAdapterUser(minimalFallbackUserContent, nil, nil, model)})
			}
		}
		result = append(result, message)
	}
	return result
}

func contentCachePoint(content interface{}, cache map[string]interface{}) *KiroCachePoint {
	if cache["type"] == "ephemeral" {
		return &KiroCachePoint{Type: "default"}
	}
	for _, block := range adapterContentBlocks(content) {
		if control, ok := block["cache_control"].(map[string]interface{}); ok && control["type"] == "ephemeral" {
			return &KiroCachePoint{Type: "default"}
		}
	}
	return nil
}

func adapterContentBlocks(content interface{}) []map[string]interface{} {
	if block, ok := content.(map[string]interface{}); ok {
		return []map[string]interface{}{block}
	}
	var result []map[string]interface{}
	if blocks, ok := content.([]interface{}); ok {
		for _, raw := range blocks {
			if block, ok := raw.(map[string]interface{}); ok {
				result = append(result, block)
			}
		}
	}
	return result
}

func documentsFromContent(content interface{}) []KiroDocument {
	var result []KiroDocument
	for _, block := range adapterContentBlocks(content) {
		kind, _ := block["type"].(string)
		if kind == "tool_result" {
			result = append(result, documentsFromContent(block["content"])...)
		}
		if kind == "document" || kind == "file" || kind == "input_file" {
			// Image files already travel as images, never as duplicate documents.
			if extractImageFromOpenAIPart(block) != nil {
				continue
			}
			document, err := adapterDocument(block)
			if err == nil {
				result = append(result, document)
			} // Shape validation reports errors before conversion.
		}
	}
	return result
}

func adapterDocument(block map[string]interface{}) (KiroDocument, error) {
	var doc KiroDocument
	doc.Name = firstString(block["title"], block["name"], block["filename"])
	var media, data, sourceType string
	if file, ok := block["file"].(map[string]interface{}); ok {
		if doc.Name == "" {
			doc.Name = firstString(file["filename"])
		}
		data = firstString(file["file_data"])
	}
	if data == "" {
		data = firstString(block["file_data"])
	}
	if source, ok := block["source"].(map[string]interface{}); ok {
		sourceType = firstString(source["type"])
		media = firstString(source["media_type"])
		data = firstString(source["data"])
		if sourceType != "base64" && sourceType != "text" {
			return doc, fmt.Errorf("unsupported document source type: %s", sourceType)
		}
	}
	if data == "" {
		return doc, fmt.Errorf("document requires inline file_data or source.data; hosted file_id and document URLs are unsupported")
	}
	if doc.Name == "" {
		doc.Name = "Document"
	}
	if strings.HasPrefix(data, "data:") {
		parts := strings.SplitN(data, ",", 2)
		if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
			return doc, fmt.Errorf("document data URL must use base64")
		}
		media = strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
		data = parts[1]
	} else if sourceType == "text" {
		data = base64.StdEncoding.EncodeToString([]byte(data))
	}
	if strings.HasPrefix(media, "image/") {
		return doc, fmt.Errorf("invalid image file encoding")
	}
	if _, err := base64.StdEncoding.DecodeString(data); err != nil {
		return doc, fmt.Errorf("invalid document base64: %w", err)
	}
	switch strings.ToLower(media) {
	case "application/pdf":
		doc.Format = "pdf"
	case "text/markdown":
		doc.Format = "md"
	case "text/csv":
		doc.Format = "csv"
	case "text/html":
		doc.Format = "html"
	default:
		extension := strings.ToLower(strings.TrimPrefix(path.Ext(doc.Name), "."))
		switch extension {
		case "pdf", "csv", "html", "md", "doc", "docx", "xls", "xlsx":
			doc.Format = extension
		default:
			doc.Format = "txt"
		}
	}
	doc.Source.Bytes = data
	return doc, nil
}

func adapterFileImage(block map[string]interface{}) *KiroImage {
	if source, ok := block["source"].(map[string]interface{}); ok {
		media := firstString(source["media_type"])
		if strings.HasPrefix(media, "image/") {
			return parseBase64Image(firstString(source["data"]), strings.TrimPrefix(media, "image/"))
		}
	}
	data := firstString(block["file_data"])
	if file, ok := block["file"].(map[string]interface{}); ok {
		data = firstString(file["file_data"])
	}
	if strings.HasPrefix(data, "data:image/") {
		return parseDataURL(data)
	}
	return nil
}

// Inactive tool calls cannot remain structured with this upstream protocol.
// Their IDs, names, and complete arguments stay in user-side context instead.
func adapterToolCallContext(uses []KiroToolUse) string {
	var parts []string
	for _, use := range uses {
		raw, _ := json.Marshal(use.Input)
		parts = append(parts, fmt.Sprintf("[Tool call context: id=%s name=%s]\n%s", use.ToolUseID, use.Name, raw))
	}
	return strings.Join(parts, "\n\n")
}

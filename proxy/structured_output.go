package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

//! Kiro has no structured output mode, so JSON output requests are met by prompting and
//! post-processing. One spec covers Messages output_config.format (and the beta
//! output_format alias), Chat response_format and Responses text.format:
//!   - the schema goes into the priming turn as an instruction, with a one-line reminder
//!     on the current turn;
//!   - a non-stream answer is reduced to its last valid JSON value, checked against the
//!     schema, and retried once with a corrective turn when it does not match;
//!   - a streamed answer is sent as it arrives, with only a leading ```json fence and its
//!     closing fence removed. It is never validated or retried: the client already holds
//!     the text by the time it could be checked.
//! Messages requests served by the web-search paths (direct or loop) do not get the spec.

const (
	structuredOutputJSONObject = "json_object"
	structuredOutputJSONSchema = "json_schema"
	// maxStructuredSchemaBytes caps the schema, which is injected after the payload was sized.
	maxStructuredSchemaBytes = 32 * 1024
	// structuredPrimingAck is the assistant half of the translators' priming pair.
	structuredPrimingAck = "I will follow these instructions."
)

type structuredOutputSpec struct {
	// Kind is structuredOutputJSONObject or structuredOutputJSONSchema.
	Kind        string
	Name        string
	Description string
	// Schema is nil when any JSON value (any object for json_object) is acceptable.
	Schema map[string]interface{}
	// SchemaText is the schema as the client wrote it, indented, keeping its key order.
	SchemaText string
	// Strict enforces additionalProperties:false.
	Strict bool
	// Stream selects the pass-through path; attachStructuredOutput sets it.
	Stream bool
}

func hasJSONValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

func structuredFormatType(format map[string]interface{}) (string, string) {
	raw, _ := format["type"].(string)
	return raw, strings.ToLower(strings.TrimSpace(raw))
}

// rawObjectField returns one member of a JSON object as the client wrote it.
func rawObjectField(raw json.RawMessage, key string) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	return fields[key]
}

// structuredSchemaField checks one schema member; raw, when known, keeps the client's key order.
func structuredSchemaField(field string, value interface{}, raw json.RawMessage, required bool) (map[string]interface{}, string, string) {
	if value == nil {
		if required {
			return nil, "", field + " is required"
		}
		return nil, "", ""
	}
	schema, ok := value.(map[string]interface{})
	if !ok {
		return nil, "", field + " must be an object"
	}
	if !hasJSONValue(raw) {
		marshalled, err := json.Marshal(schema)
		if err != nil {
			return nil, "", field + " must be valid JSON"
		}
		raw = marshalled
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, "", field + " must be valid JSON"
	}
	if compact.Len() > maxStructuredSchemaBytes {
		return nil, "", fmt.Sprintf("%s is too large (max %d bytes)", field, maxStructuredSchemaBytes)
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, compact.Bytes(), "", "  "); err != nil {
		return nil, "", field + " must be valid JSON"
	}
	return schema, indented.String(), ""
}

// structuredSpecFromHolder reads the OpenAI shape {name, description, schema, strict}.
func structuredSpecFromHolder(field string, holder map[string]interface{}, raw json.RawMessage) (*structuredOutputSpec, string) {
	spec := &structuredOutputSpec{Kind: structuredOutputJSONSchema}
	if holder == nil {
		return spec, ""
	}
	spec.Name, _ = holder["name"].(string)
	spec.Description, _ = holder["description"].(string)
	spec.Strict, _ = holder["strict"].(bool)
	schema, text, msg := structuredSchemaField(field+".schema", holder["schema"], rawObjectField(raw, "schema"), false)
	if msg != "" {
		return nil, msg
	}
	spec.Schema, spec.SchemaText = schema, text
	return spec, ""
}

// parseClaudeStructuredOutput reads output_config.format, or the beta output_format alias.
func parseClaudeStructuredOutput(req *ClaudeRequest) (*structuredOutputSpec, string) {
	if req == nil {
		return nil, ""
	}
	field, raw := "output_format", req.OutputFormat
	if req.OutputConfig != nil && hasJSONValue(req.OutputConfig.Format) {
		field, raw = "output_config.format", req.OutputConfig.Format
	}
	if !hasJSONValue(raw) {
		return nil, ""
	}
	var format map[string]interface{}
	if err := json.Unmarshal(raw, &format); err != nil || format == nil {
		return nil, field + " must be an object"
	}
	rawType, kind := structuredFormatType(format)
	if kind != structuredOutputJSONSchema {
		return nil, "unsupported " + field + " type: " + rawType
	}
	schema, text, msg := structuredSchemaField(field+".schema", format["schema"], rawObjectField(raw, "schema"), true)
	if msg != "" {
		return nil, msg
	}
	//! Anthropic structured outputs are always strict.
	return &structuredOutputSpec{Kind: structuredOutputJSONSchema, Schema: schema, SchemaText: text, Strict: true}, ""
}

func claudeStructuredOutputSpec(req *ClaudeRequest) *structuredOutputSpec {
	spec, _ := parseClaudeStructuredOutput(req)
	return spec
}

func validateClaudeStructuredOutput(req *ClaudeRequest) string {
	_, msg := parseClaudeStructuredOutput(req)
	return msg
}

// parseChatResponseFormat reads Chat Completions response_format.
func parseChatResponseFormat(raw json.RawMessage) (*structuredOutputSpec, string) {
	if !hasJSONValue(raw) {
		return nil, ""
	}
	var format map[string]interface{}
	if err := json.Unmarshal(raw, &format); err != nil || format == nil {
		return nil, "response_format must be an object"
	}
	rawType, kind := structuredFormatType(format)
	switch kind {
	case "", "text":
		return nil, ""
	case structuredOutputJSONObject:
		return &structuredOutputSpec{Kind: structuredOutputJSONObject}, ""
	case structuredOutputJSONSchema:
		holder, ok := format["json_schema"].(map[string]interface{})
		if !ok && format["json_schema"] != nil {
			return nil, "response_format.json_schema must be an object"
		}
		return structuredSpecFromHolder("response_format.json_schema", holder, rawObjectField(raw, "json_schema"))
	}
	return nil, "unsupported response_format type: " + rawType
}

func chatStructuredOutputSpec(req *OpenAIRequest) *structuredOutputSpec {
	if req == nil {
		return nil
	}
	spec, _ := parseChatResponseFormat(req.ResponseFormat)
	return spec
}

func validateChatResponseFormat(req *OpenAIRequest) string {
	if req == nil {
		return ""
	}
	_, msg := parseChatResponseFormat(req.ResponseFormat)
	return msg
}

// parseResponsesTextFormat reads the flat Responses shape text.format {type, name, schema, strict}.
func parseResponsesTextFormat(text *OpenAIResponsesText) (*structuredOutputSpec, string) {
	if text == nil || len(text.Format) == 0 {
		return nil, ""
	}
	rawType, kind := structuredFormatType(text.Format)
	switch kind {
	case "", "text":
		return nil, ""
	case structuredOutputJSONObject:
		return &structuredOutputSpec{Kind: structuredOutputJSONObject}, ""
	case structuredOutputJSONSchema:
		return structuredSpecFromHolder("text.format", text.Format, text.formatRaw)
	}
	return nil, "unsupported text.format type: " + rawType
}

// UnmarshalJSON keeps text.format as written, so the injected schema keeps the client's key order.
func (t *OpenAIResponsesText) UnmarshalJSON(data []byte) error {
	type plain OpenAIResponsesText
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*t = OpenAIResponsesText(decoded)
	t.formatRaw = rawObjectField(data, "format")
	return nil
}

func structuredOutputInstruction(spec *structuredOutputSpec) string {
	const noExtras = "Output nothing else: no markdown code fences, no comments and no text before or after the JSON. Use double quotes for every property name and string."
	if spec.Schema == nil {
		if spec.Kind == structuredOutputJSONObject {
			return "Respond only with a single valid JSON object. " + noExtras
		}
		return "Respond only with a single valid JSON value. " + noExtras
	}
	var b strings.Builder
	b.WriteString("Respond only with valid JSON that matches the JSON schema below.\n")
	b.WriteString("- Output a single JSON value and nothing else: no markdown code fences, no comments and no text before or after the JSON.\n")
	b.WriteString("- Use double quotes for every property name and string.\n")
	b.WriteString("- Include every required property, and use only the values an enum lists.\n")
	if spec.Strict {
		b.WriteString("- Do not add properties the schema does not define.\n")
	}
	if name := strings.TrimSpace(spec.Name); name != "" {
		b.WriteString("Schema name: " + name + "\n")
	}
	if description := strings.TrimSpace(spec.Description); description != "" {
		b.WriteString("Schema description: " + description + "\n")
	}
	b.WriteString("JSON schema:\n")
	b.WriteString(spec.SchemaText)
	return b.String()
}

// structuredOutputThinkingFormat is the thinking format a response uses. The text formats
// (think and thinking tags on Chat; think tags and plain reasoning_content on Messages)
// write the reasoning into the content, ahead of the JSON the client parses. A request
// with a spec gets separate instead: reasoning_content on Chat, thinking blocks on Messages.
func structuredOutputThinkingFormat(spec *structuredOutputSpec, format, separate string) string {
	if spec == nil {
		return format
	}
	return separate
}

// structuredOutputPromptTokens estimates what attachStructuredOutput adds to the prompt: the
// instruction, the current-turn reminder and, when there is no system prompt to join, the
// priming acknowledgement.
func structuredOutputPromptTokens(spec *structuredOutputSpec, hasSystem bool) int {
	if spec == nil {
		return 0
	}
	total := estimateApproxTokens(structuredOutputInstruction(spec)) + estimateApproxTokens(structuredOutputReminder(spec))
	if !hasSystem {
		total += estimateApproxTokens(structuredPrimingAck)
	}
	return total
}

func structuredOutputReminder(spec *structuredOutputSpec) string {
	if spec.Schema != nil {
		return "Format your final answer as only the JSON value that matches the JSON schema in the instructions: no code fences, no other text."
	}
	if spec.Kind == structuredOutputJSONObject {
		return "Format your final answer as only one valid JSON object: no code fences, no other text."
	}
	return "Format your final answer as only one valid JSON value: no code fences, no other text."
}

func appendStructuredText(existing, addition string) string {
	if strings.TrimSpace(existing) == "" {
		return addition
	}
	return strings.TrimRight(existing, " \t\r\n") + "\n\n" + addition
}

func hasPrimingTurn(history []KiroHistoryMessage) bool {
	return len(history) >= 2 &&
		history[0].UserInputMessage != nil &&
		history[1].AssistantResponseMessage != nil &&
		history[1].AssistantResponseMessage.Content == structuredPrimingAck
}

// attachStructuredOutput injects the output instruction into a translated payload and marks it
// for the structured call path. A nil spec leaves the payload untouched.
func attachStructuredOutput(payload *KiroPayload, spec *structuredOutputSpec, stream bool) {
	if payload == nil || spec == nil {
		return
	}
	//! The instruction joins the priming turn, not the request's system text: the prompt
	//! filters replace a Claude Code system prompt wholesale and would drop it.
	instruction := structuredOutputInstruction(spec)
	current := &payload.ConversationState.CurrentMessage.UserInputMessage
	history := payload.ConversationState.History
	if hasPrimingTurn(history) {
		primed := *history[0].UserInputMessage
		primed.Content = appendStructuredText(primed.Content, instruction)
		rebuilt := append([]KiroHistoryMessage(nil), history...)
		rebuilt[0].UserInputMessage = &primed
		payload.ConversationState.History = rebuilt
	} else {
		priming := []KiroHistoryMessage{
			{UserInputMessage: &KiroUserInputMessage{Content: instruction, ModelID: current.ModelID, Origin: current.Origin}},
			{AssistantResponseMessage: &KiroAssistantResponseMessage{Content: structuredPrimingAck}},
		}
		payload.ConversationState.History = append(priming, history...)
	}
	//! Weaker models drift from an instruction far up the history; the current turn repeats it.
	current.Content = appendStructuredText(current.Content, structuredOutputReminder(spec))

	marked := *spec
	marked.Stream = stream
	payload.StructuredOutput = &marked
	truncatePayloadToLimit(payload, true)
}

package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

// validateClaudeMessageRoles names a message whose role the Messages API does not have. A
// mid-conversation "system" entry is Claude Code's and is folded into a user turn.
func validateClaudeMessageRoles(messages []ClaudeMessage) string {
	for i, message := range messages {
		switch strings.TrimSpace(message.Role) {
		case "user", "assistant", "system":
		default:
			return fmt.Sprintf("messages.%d.role must be \"user\" or \"assistant\", got %q", i, message.Role)
		}
	}
	return ""
}

// validateClaudeMessageContent names a message whose content is neither a string nor an array
// of content blocks. Without it, content: 5 read as "at least one non-empty user message".
func validateClaudeMessageContent(messages []ClaudeMessage) string {
	for i, message := range messages {
		if !isTextOrList(message.Content) {
			return fmt.Sprintf("messages.%d.content must be a string or an array of content blocks, not %s", i, jsonValueKind(message.Content))
		}
	}
	return ""
}

// validateOpenAIMessageRoles names a message whose role Chat Completions does not have, or
// whose content is neither a string nor an array of content parts.
func validateOpenAIMessageRoles(messages []OpenAIMessage) string {
	for i, message := range messages {
		switch strings.TrimSpace(message.Role) {
		case "system", "developer", "user", "assistant", "tool", "function":
		default:
			return fmt.Sprintf("messages[%d].role must be one of system, developer, user, assistant or tool, got %q", i, message.Role)
		}
		if !isTextOrList(message.Content) {
			return fmt.Sprintf("messages[%d].content must be a string or an array of content parts, not %s", i, jsonValueKind(message.Content))
		}
	}
	return ""
}

// isTextOrList reports whether a decoded content value is a string, a list or absent. An
// absent (null) content stays allowed: an assistant turn that only calls tools has none.
func isTextOrList(content interface{}) bool {
	if content == nil {
		return true
	}
	if _, ok := content.(string); ok {
		return true
	}
	kind := reflect.TypeOf(content).Kind()
	return kind == reflect.Slice || kind == reflect.Array
}

// jsonValueKind names the JSON type of a decoded value, for a validation message.
func jsonValueKind(value interface{}) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	case float64, float32, int, int64, json.Number:
		return "a number"
	case []interface{}:
		return "an array"
	case map[string]interface{}:
		return "an object"
	}
	return "another type"
}

// validateClaudeCountTokensShape is the part of the Messages checks that count_tokens shares:
// it needs messages with known roles and content types, but no max_tokens and no final user turn.
func validateClaudeCountTokensShape(req *ClaudeRequest) string {
	if len(req.Messages) == 0 {
		return "messages must not be empty"
	}
	if msg := validateClaudeMessageRoles(req.Messages); msg != "" {
		return msg
	}
	return validateClaudeMessageContent(req.Messages)
}

// openAIRequestChecks words the checks Chat Completions and the Responses API share, each in
// its own field names: a Responses request is checked after its input becomes chat messages.
type openAIRequestChecks struct {
	maxTokens   string
	noNonSystem string
	prefill     string
	noUserText  string
}

var chatRequestChecks = openAIRequestChecks{
	maxTokens:   "max_tokens",
	noNonSystem: "at least one non-system message is required",
	prefill:     "assistant-prefill final message is not supported; last message must be user or tool",
	noUserText:  "at least one non-empty user message is required",
}

var responsesRequestChecks = openAIRequestChecks{
	maxTokens:   "max_output_tokens",
	noNonSystem: "input needs at least one item that is not a system or developer message",
	prefill:     "input must not end with an assistant message: prefill is not supported",
	noUserText:  "input needs at least one user message with content",
}

const interleavedThinkingBeta = "interleaved-thinking-2025-05-14"

var claudeFamilyVersion = regexp.MustCompile(`(opus|sonnet)-(\d+)`)

// claudeInterleavedThinking reports whether the request turns interleaved thinking on for a model
// that has it: Claude Opus and Sonnet from version 4. Haiku 4.5 has no interleaved thinking.
func claudeInterleavedThinking(r *http.Request, model string) bool {
	if r == nil || !anthropicBetaEnabled(r, interleavedThinkingBeta) {
		return false
	}
	for _, name := range []string{model, requestLogModel(model)} {
		m := claudeFamilyVersion.FindStringSubmatch(strings.ToLower(name))
		if len(m) == 3 {
			if major, err := strconv.Atoi(m[2]); err == nil && major >= 4 {
				return true
			}
		}
	}
	return false
}

func anthropicBetaEnabled(r *http.Request, beta string) bool {
	for _, header := range r.Header.Values("anthropic-beta") {
		for _, item := range strings.Split(header, ",") {
			if strings.EqualFold(strings.TrimSpace(item), beta) {
				return true
			}
		}
	}
	return false
}

// clientJSONError describes a request body that did not decode, in the API's terms. Go's own
// text named internal types ("Go struct field ClaudeRequest.messages of type []proxy.ClaudeMessage").
func clientJSONError(err error) string {
	var typeErr *json.UnmarshalTypeError
	var syntaxErr *json.SyntaxError
	switch {
	case errors.As(err, &typeErr):
		field := typeErr.Field
		if field == "" {
			return fmt.Sprintf("Invalid JSON: the body must be an object, not %s", jsonValueName(typeErr.Value))
		}
		return fmt.Sprintf("Invalid JSON: %s must be %s, not %s", field, jsonKindName(typeErr.Type), jsonValueName(typeErr.Value))
	case errors.Is(err, io.ErrUnexpectedEOF) || (errors.As(err, &syntaxErr) && strings.Contains(syntaxErr.Error(), "unexpected end of JSON input")):
		return "Invalid JSON: the body ends too early"
	case errors.As(err, &syntaxErr):
		return fmt.Sprintf("Invalid JSON at byte %d: %s", syntaxErr.Offset, syntaxErr.Error())
	}
	return "Invalid JSON"
}

func jsonKindName(t reflect.Type) string {
	if t == nil {
		return "another type"
	}
	switch t.Kind() {
	case reflect.Slice, reflect.Array:
		return "an array"
	case reflect.Map, reflect.Struct:
		return "an object"
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "a boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "a whole number"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Pointer:
		return jsonKindName(t.Elem())
	}
	return "another type"
}

func jsonValueName(value string) string {
	switch value {
	case "string", "number", "array", "object", "bool":
		if value == "bool" {
			return "a boolean"
		}
		if value == "array" || value == "object" {
			return "an " + value
		}
		return "a " + value
	}
	if strings.HasPrefix(value, "number") {
		return "a number"
	}
	return value
}

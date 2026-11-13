package proxy

import (
	"context"
	"net/http"
)

// OpenAIStreamOptions is the stream_options object of a Chat Completions request.
type OpenAIStreamOptions struct {
	// IncludeUsage asks for one more chunk before [DONE]: empty choices and the
	// usage of the whole request, as the OpenAI API sends it.
	IncludeUsage bool `json:"include_usage,omitempty"`
}

type chatStreamUsageKey struct{}

// withChatStreamUsage marks the request when the client asked for the separate usage chunk.
func withChatStreamUsage(r *http.Request, opts *OpenAIStreamOptions) *http.Request {
	if opts == nil || !opts.IncludeUsage {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), chatStreamUsageKey{}, true))
}

func chatStreamWantsUsageChunk(ctx context.Context) bool {
	want, _ := ctx.Value(chatStreamUsageKey{}).(bool)
	return want
}

// chatUsageChunk is the last chunk before [DONE] when stream_options.include_usage is set.
func chatUsageChunk(chatID, model string, created int64, usage map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"id":      chatID,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []map[string]interface{}{},
		"usage":   usage,
	}
}

// withAssistantRole puts role "assistant" on a chunk's delta. OpenAI sends it on
// the first chunk of a chat stream, and some clients take the role from there.
func withAssistantRole(chunk map[string]interface{}) {
	choices, _ := chunk["choices"].([]map[string]interface{})
	if len(choices) == 0 {
		return
	}
	switch delta := choices[0]["delta"].(type) {
	case map[string]string:
		delta["role"] = "assistant"
	case map[string]interface{}:
		delta["role"] = "assistant"
	}
}

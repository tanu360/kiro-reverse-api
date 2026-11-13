package proxy

import (
	"encoding/json"
	"strings"
)

// maxOpenAIStopSequences is the most stop sequences the Chat Completions API takes.
const maxOpenAIStopSequences = 4

// openAIStopSequences reads Chat Completions' stop field: null, one string or a list of strings.
func openAIStopSequences(raw json.RawMessage) ([]string, string) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, ""
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		if one == "" {
			return nil, ""
		}
		return []string{one}, ""
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, "stop must be a string or a list of strings"
	}
	if len(list) > maxOpenAIStopSequences {
		return nil, "stop takes at most 4 sequences"
	}
	stops := make([]string, 0, len(list))
	for _, s := range list {
		if s != "" {
			stops = append(stops, s)
		}
	}
	return stops, ""
}

// validateOpenAIOutputOptions refuses options the proxy cannot honour instead of ignoring them:
// Kiro returns one answer and no token probabilities.
func validateOpenAIOutputOptions(req *OpenAIRequest) string {
	if _, msg := openAIStopSequences(req.Stop); msg != "" {
		return msg
	}
	if req.N != nil && *req.N != 1 {
		return "n must be 1: this server returns one choice per request"
	}
	if req.Logprobs != nil && *req.Logprobs {
		return "logprobs is not supported by this server"
	}
	if req.TopLogprobs != nil && *req.TopLogprobs > 0 {
		return "top_logprobs is not supported by this server"
	}
	if req.MaxTokens < 0 || req.MaxCompletionTokens < 0 {
		return "max_tokens must be a positive number"
	}
	return ""
}

// openAIMaxOutputTokens is the request's output cap: max_completion_tokens, else max_tokens.
func openAIMaxOutputTokens(req *OpenAIRequest) int {
	if req.MaxCompletionTokens > 0 {
		return req.MaxCompletionTokens
	}
	return req.MaxTokens
}

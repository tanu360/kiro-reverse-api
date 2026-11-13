package proxy

import "strings"

// OpenAITokenDetails contains the cache components OpenAI-compatible clients
// understand. CachedTokens and CacheWriteTokens are subsets of the top-level
// input/prompt token count.
type OpenAITokenDetails struct {
	CachedTokens     int  `json:"cached_tokens"`
	CacheWriteTokens int  `json:"cache_write_tokens"`
	Estimated        bool `json:"estimated"`
}

func resolveOpenAICacheUsage(tracker *promptCacheTracker, accountID string, payload *KiroPayload, inputTokens int) *OpenAITokenDetails {
	if tracker == nil {
		return nil
	}
	profile := tracker.BuildOpenAIProfile(payload, inputTokens)
	if profile == nil {
		return nil
	}
	estimated := tracker.Compute(accountID, profile)
	// Store only after a successful upstream response.
	tracker.Update(accountID, profile)
	if estimated.CacheReadInputTokens == 0 && estimated.CacheCreationInputTokens == 0 {
		return nil
	}
	return &OpenAITokenDetails{
		CachedTokens:     estimated.CacheReadInputTokens,
		CacheWriteTokens: estimated.CacheCreationInputTokens,
		Estimated:        true,
	}
}

// addResponsesCacheUsage fills the Responses usage details. Both are always present, as the
// OpenAI API sends them: a client reading reasoning_tokens (Codex's reasoning_output_tokens)
// got nothing, and stream and non-stream answers had different shapes.
func addResponsesCacheUsage(response map[string]interface{}, details *OpenAITokenDetails, reasoningTokens int) {
	values, ok := response["usage"].(map[string]int)
	if !ok {
		return
	}
	usage := make(map[string]interface{}, len(values)+2)
	for key, value := range values {
		usage[key] = value
	}
	usage["input_tokens_details"] = cacheDetailsOrZero(details)
	usage["output_tokens_details"] = map[string]int{"reasoning_tokens": reasoningTokens}
	response["usage"] = usage
}

func buildOpenAIUsage(inputTokens, outputTokens int, details *OpenAITokenDetails, reasoningTokens int) map[string]interface{} {
	return map[string]interface{}{
		"prompt_tokens":             inputTokens,
		"completion_tokens":         outputTokens,
		"total_tokens":              inputTokens + outputTokens,
		"prompt_tokens_details":     cacheDetailsOrZero(details),
		"completion_tokens_details": map[string]int{"reasoning_tokens": reasoningTokens},
	}
}

func cacheDetailsOrZero(details *OpenAITokenDetails) *OpenAITokenDetails {
	if details == nil {
		return &OpenAITokenDetails{}
	}
	return details
}

// reasoningTokenCount is the part of the output that was reasoning. Kiro counts output as one
// number, so the reasoning text is estimated and capped by that number.
func reasoningTokenCount(reasoning string, outputTokens int) int {
	if strings.TrimSpace(reasoning) == "" {
		return 0
	}
	return min(estimateApproxTokens(reasoning), max(outputTokens, 0))
}

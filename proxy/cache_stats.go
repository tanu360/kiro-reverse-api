package proxy

import (
	"context"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// resolveCacheTokens prefers the cache counts Kiro reported and falls back to
// the local prompt-cache estimate. The result never exceeds the input total,
// so the input/output totals keep their meaning.
func resolveCacheTokens(upstream, estimate cacheTokenCounts, inputTokens int) cacheTokenCounts {
	if inputTokens <= 0 {
		return cacheTokenCounts{}
	}
	cache := estimate
	if upstream.Read+upstream.Write > 0 {
		cache = upstream
	}
	cache.Read = minInt(maxInt(cache.Read, 0), inputTokens)
	cache.Write = minInt(maxInt(cache.Write, 0), inputTokens-cache.Read)
	return cache
}

func cacheTokensFromPromptCache(usage promptCacheUsage) cacheTokenCounts {
	return cacheTokenCounts{Read: usage.CacheReadInputTokens, Write: usage.CacheCreationInputTokens}
}

func cacheTokensFromOpenAIDetails(details *OpenAITokenDetails) cacheTokenCounts {
	if details == nil {
		return cacheTokenCounts{}
	}
	return cacheTokenCounts{Read: details.CachedTokens, Write: details.CacheWriteTokens}
}

// refusedRequestMessage is the request log's message for a call the model refused.
const refusedRequestMessage = "The model refused this request (stop reason: refusal)."

// recordObservedSuccess records a successful request in the request log,
// which also counts it once in the observe buckets and model stats, including
// its cache-read and cache-write share. A content refusal is a successful call (the account is
// fine), but the log and the server log say so: it looked like an empty answer.
func recordObservedSuccess(ctx context.Context, apiKeyReservation *apiKeyUsageReservation, account *config.Account, model string, inTokens, outTokens int, credits float64, cache cacheTokenCounts, stopReason string) {
	accountID, email := accountIdentity(account)
	message := ""
	if mapClaudeStopReason(stopReason, 0) == "refusal" {
		message = refusedRequestMessage
		logger.Warnf("[Request] %s refused the request (upstream stop reason %q, %d output tokens)", model, stopReason, outTokens)
	}
	getObserveStore().RecordTracedRequestWithCache(requestTraceFromContext(ctx), accountID, apiKeyReservation.apiKeyID(), apiKeyReservation.apiKeyValue(), email, model, inTokens, outTokens, credits, true, 200, message, cache)
}

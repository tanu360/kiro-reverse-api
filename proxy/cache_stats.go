package proxy

import (
	"context"

	"kiro-proxy/config"
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

// recordObservedSuccess records a successful request in the observe buckets,
// model stats and request log, including its cache-read and cache-write share.
func recordObservedSuccess(ctx context.Context, apiKeyReservation *apiKeyUsageReservation, account *config.Account, model string, inTokens, outTokens int, credits float64, cache cacheTokenCounts) {
	accountID, email := accountIdentity(account)
	store := getObserveStore()
	store.RecordSuccessWithCache(accountID, model, inTokens, outTokens, credits, cache)
	store.RecordTracedRequestWithCache(requestTraceFromContext(ctx), accountID, apiKeyReservation.apiKeyID(), apiKeyReservation.apiKeyValue(), email, model, inTokens, outTokens, credits, true, 200, "", cache)
}

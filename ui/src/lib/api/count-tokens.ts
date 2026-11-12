import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/** How the external count_tokens API receives its key. */
export type CountTokensAuthType = "x-api-key" | "bearer";

/**
 * GET /count-tokens. An empty URL means count_tokens answers with the local estimate. The key is
 * write-only: only whether one is saved and its masked tail ("••••abcd", or "••••") come back.
 */
export interface CountTokensConfig {
  countTokensApiUrl: string;
  countTokensAuthType: CountTokensAuthType;
  countTokensApiKeySet: boolean;
  countTokensApiKeyMasked: string;
}

/**
 * POST /count-tokens. An omitted field keeps its saved value; an empty URL turns the external
 * API off and drops the key. An empty or omitted key keeps the saved one; clearApiKey drops it.
 * 400 count_tokens_url_invalid, count_tokens_auth_type or count_tokens_key_invalid.
 */
export interface CountTokensConfigUpdate {
  countTokensApiUrl?: string;
  countTokensAuthType?: CountTokensAuthType;
  countTokensApiKey?: string;
  clearApiKey?: boolean;
}

function getCountTokensConfig(): Promise<CountTokensConfig> {
  return apiRequest("/count-tokens");
}

export function countTokensQuery() {
  return queryOptions({
    queryKey: queryKeys.settings.countTokens(),
    queryFn: getCountTokensConfig,
  });
}

export function updateCountTokensConfig(body: CountTokensConfigUpdate): Promise<SuccessResponse> {
  return apiRequest("/count-tokens", { method: "POST", body });
}

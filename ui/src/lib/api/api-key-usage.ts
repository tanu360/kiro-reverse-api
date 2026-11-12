import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

// GET /admin/api/api-keys/usage (proxy/apikey_usage.go): the request log bucketed per API key.

export type ApiKeyUsageRange = "24h" | "7d" | "30d";
export const API_KEY_USAGE_RANGES: readonly ApiKeyUsageRange[] = ["24h", "7d", "30d"];

/**
 * `key` a configured key; `deleted` a key ID config no longer has; `invalid` every rejected key
 * that matches no configured key, together; `none` requests sent without a key.
 */
export type ApiKeyUsageKind = "key" | "deleted" | "invalid" | "none";

export interface ApiKeyUsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  inTokens: number;
  outTokens: number;
  /** inTokens + outTokens */
  tokens: number;
  credits: number;
}

export interface ApiKeyUsageEntry {
  /** The key's ID for `key` and `deleted`; "invalid" or "none" otherwise. */
  id: string;
  kind: ApiKeyUsageKind;
  name?: string;
  /** Never the secret: config.MaskApiKey of the key (or of a deleted key's last value). */
  keyMasked?: string;
  totals: ApiKeyUsageTotals;
  /** One per bucket, oldest first, zeros included. */
  series: ApiKeyUsageTotals[];
}

export interface ApiKeyUsageResponse {
  range: ApiKeyUsageRange;
  bucket: "hour" | "day";
  bucketSeconds: number;
  /** Minutes east of UTC the buckets start at (the viewer's local hour or midnight). */
  tzOffset: number;
  /** unix s, inclusive */
  from: number;
  /** unix s, exclusive: the end of the current, partial bucket */
  to: number;
  nowUnix: number;
  /** Bucket starts, unix s, oldest first. */
  buckets: number[];
  totals: ApiKeyUsageTotals;
  /** Only keys with traffic in the range, busiest first. */
  keys: ApiKeyUsageEntry[];
}

/** The viewer's offset as the server takes it: minutes east of UTC. */
export function browserTzOffset(): number {
  return -new Date().getTimezoneOffset();
}

export function getApiKeyUsage(
  range: ApiKeyUsageRange,
  tzOffset: number,
): Promise<ApiKeyUsageResponse> {
  return apiRequest("/api-keys/usage", { query: { range, tzOffset } });
}

/**
 * Under the API keys' key, so a key change (api_keys_changed) or a statistics reset (stats_reset)
 * refetches it. Not an observe query: SSE ticks leave it alone (a 30-day scan each tick would be
 * wasteful); it polls every 60 s instead.
 */
export function apiKeyUsageQuery(range: ApiKeyUsageRange, tzOffset = browserTzOffset()) {
  return queryOptions({
    queryKey: [...queryKeys.apiKeys.all, "usage", range, tzOffset] as const,
    queryFn: () => getApiKeyUsage(range, tzOffset),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

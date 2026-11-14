import { queryOptions } from "@tanstack/react-query";
import type { TimeBucket } from "../time-buckets";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

// GET /admin/api/api-keys/usage (proxy/apikey_usage.go): the request log bucketed per API key.

/** `all` is every logged request, including the totals log retention kept of pruned rows. */
export type ApiKeyUsageRange = "24h" | "7d" | "30d" | "all";
export const API_KEY_USAGE_RANGES: readonly ApiKeyUsageRange[] = ["24h", "7d", "30d", "all"];

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
  /**
   * All time only: the part of `totals` that has no day, so no bucket (rows log retention pruned
   * before it kept daily totals). Absent when there is none.
   */
  earlier?: ApiKeyUsageTotals;
}

export interface ApiKeyUsageResponse {
  range: ApiKeyUsageRange;
  /** 24h: hour; 7d and 30d: day; all: day, week, month or year, by the span of the log. */
  bucket: TimeBucket;
  /** 0 for a month or a year, which vary in length. */
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
  /** The sum of the entries' `earlier`; absent when there is none. */
  earlier?: ApiKeyUsageTotals;
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
 * wasteful); it polls every 60 s instead, and All time, which scans the whole log for bars of a
 * day or more, every 5 minutes.
 */
export function apiKeyUsageQuery(range: ApiKeyUsageRange, tzOffset = browserTzOffset()) {
  return queryOptions({
    queryKey: [...queryKeys.apiKeys.all, "usage", range, tzOffset] as const,
    queryFn: () => getApiKeyUsage(range, tzOffset),
    refetchInterval: range === "all" ? 300_000 : 60_000,
    staleTime: 30_000,
  });
}

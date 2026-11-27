import type {
  ApiKeyUsageEntry,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";

// Pure helpers for the per-key usage card and sheet: no React, so they test on their own.

export type UsageMetric = "requests" | "tokens" | "credits";
/** The measures the usage sheet's chart switches between. */
export const SHEET_METRICS: readonly UsageMetric[] = ["requests", "tokens", "credits"];

export const EMPTY_TOTALS: ApiKeyUsageTotals = {
  requests: 0,
  succeeded: 0,
  failed: 0,
  inTokens: 0,
  outTokens: 0,
  tokens: 0,
  credits: 0,
};

/**
 * A stable handle on one usage row: `key:<id>` and `deleted:<id>` for keys, `none` and
 * `invalid` for the two groups. A deleted key that is created again with the same value gets a
 * new ID, so the two never share a handle.
 */
export function entryRef(entry: Pick<ApiKeyUsageEntry, "id" | "kind">): string {
  return entry.kind === "key" || entry.kind === "deleted"
    ? `${entry.kind}:${entry.id}`
    : entry.kind;
}

/** The handle of a configured key, for opening its usage from the keys table. */
export function keyEntryRef(id: string): string {
  return `key:${id}`;
}

export function findEntry(
  data: ApiKeyUsageResponse | undefined,
  ref: string,
): ApiKeyUsageEntry | undefined {
  return data?.keys.find((entry) => entryRef(entry) === ref);
}

/**
 * One chart bar: `primary` at the bottom of the stack and `secondary` on top. Requests are
 * succeeded under failed, tokens input under output; credits have no second part.
 */
interface UsageBar {
  start: number;
  primary: number;
  secondary: number;
}

/** A bar per bucket, zeros for a key with no traffic in the range. */
export function seriesBars(
  data: ApiKeyUsageResponse,
  entry: ApiKeyUsageEntry | undefined,
  metric: UsageMetric,
): UsageBar[] {
  return data.buckets.map((start, index) => {
    const totals = entry?.series[index] ?? EMPTY_TOTALS;
    if (metric === "tokens") {
      return { start, primary: totals.inTokens, secondary: totals.outTokens };
    }
    if (metric === "credits") return { start, primary: totals.credits, secondary: 0 };
    return { start, primary: totals.succeeded, secondary: totals.failed };
  });
}

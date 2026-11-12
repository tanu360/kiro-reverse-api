import type {
  ApiKeyUsageEntry,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import { dateTimeFormat } from "@/lib/format";
import type { Lang } from "@/lib/i18n";

// Pure helpers for the per-key usage card and sheet: no React, so they test on their own.

export type UsageMetric = "requests" | "tokens" | "credits";
/** The comparison card ranks by these; the sheet adds tokens. */
export const CARD_METRICS: readonly UsageMetric[] = ["requests", "credits"];
export const SHEET_METRICS: readonly UsageMetric[] = ["requests", "tokens", "credits"];

export function isUsageMetric(
  value: unknown,
  allowed: readonly UsageMetric[],
): value is UsageMetric {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * The usage chart's height, sized by its card's width (SectionCard is a container). Here, not in
 * the lazy chart module, so the sheet's placeholder holds the layout without loading the chart.
 */
export const USAGE_PLOT_HEIGHT = "h-56 @2xl:h-64";

/** Keys listed by name in the card; the rest is one "N other keys" row. */
export const TOP_KEYS = 5;

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

/** The row's amount in the chosen measure. */
export function metricAmount(totals: ApiKeyUsageTotals, metric: UsageMetric): number {
  if (metric === "credits") return totals.credits;
  if (metric === "tokens") return totals.tokens;
  return totals.requests;
}

export function addTotals(a: ApiKeyUsageTotals, b: ApiKeyUsageTotals): ApiKeyUsageTotals {
  return {
    requests: a.requests + b.requests,
    succeeded: a.succeeded + b.succeeded,
    failed: a.failed + b.failed,
    inTokens: a.inTokens + b.inTokens,
    outTokens: a.outTokens + b.outTokens,
    tokens: a.tokens + b.tokens,
    credits: a.credits + b.credits,
  };
}

export interface RankedKeys {
  /** The busiest entries in the measure, at most `top`. */
  rows: ApiKeyUsageEntry[];
  /** Everything after them, summed; null when nothing is left over. */
  other: { count: number; totals: ApiKeyUsageTotals } | null;
}

/** Ranks by the measure, then by requests, then by handle, so ties never reorder on a refetch. */
export function rankEntries(
  entries: readonly ApiKeyUsageEntry[],
  metric: UsageMetric,
  top = TOP_KEYS,
): RankedKeys {
  const sorted = [...entries].sort((a, b) => {
    const byMetric = metricAmount(b.totals, metric) - metricAmount(a.totals, metric);
    if (byMetric !== 0) return byMetric;
    if (b.totals.requests !== a.totals.requests) return b.totals.requests - a.totals.requests;
    const ra = entryRef(a);
    const rb = entryRef(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  const rows = sorted.slice(0, Math.max(0, top));
  const rest = sorted.slice(rows.length);
  return {
    rows,
    other:
      rest.length > 0
        ? {
            count: rest.length,
            totals: rest.reduce((sum, entry) => addTotals(sum, entry.totals), EMPTY_TOTALS),
          }
        : null,
  };
}

/**
 * One chart bar: `primary` at the bottom of the stack and `secondary` on top. Requests are
 * succeeded under failed, tokens input under output; credits have no second part.
 */
export interface UsageBar {
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

/**
 * The wall clock at a bucket start in the offset the server bucketed with, read back in UTC. The
 * labels then always match the buckets: no two hours share a label across a DST change.
 */
function wallClock(start: number, tzOffset: number): Date {
  return new Date((start + tzOffset * 60) * 1000);
}

/** The axis label: "14:00" for an hour, "Mar 10" for a day. */
export function bucketLabel(
  start: number,
  bucket: "hour" | "day",
  tzOffset: number,
  lang: Lang,
): string {
  const options: Intl.DateTimeFormatOptions =
    bucket === "hour"
      ? { timeStyle: "short", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" };
  return dateTimeFormat(lang, options).format(wallClock(start, tzOffset));
}

/** The tooltip title: "14:00–15:00" for an hour, "Tue, Mar 10" for a day. */
export function bucketTitle(
  start: number,
  bucket: "hour" | "day",
  bucketSeconds: number,
  tzOffset: number,
  lang: Lang,
): string {
  if (bucket === "hour") {
    return `${bucketLabel(start, bucket, tzOffset, lang)}–${bucketLabel(start + bucketSeconds, bucket, tzOffset, lang)}`;
  }
  return dateTimeFormat(lang, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(wallClock(start, tzOffset));
}

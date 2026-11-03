import type { Lang } from "@/lib/i18n";

export const EMPTY = "—";

function locale(lang?: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}

function finite(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Drops trailing zeros after the decimal point, and the point itself when nothing is left. */
function trimZeros(text: string): string {
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Grouped integer (truncated toward zero). */
export function formatNumber(value: number, lang?: Lang): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 0 }).format(
    Math.trunc(finite(value)),
  );
}

export function formatDecimal(value: number, digits: number, lang?: Lang): string {
  return new Intl.NumberFormat(locale(lang), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(finite(value));
}

/** 999, 1K, 1.2K, 3.4M, 5B: one decimal, a trailing ".0" dropped. */
export function formatCompact(value: number): string {
  const n = finite(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.trunc(n));
}

/** part/total as a percent: 1 decimal from 10 % up, else 2, trailing zeros dropped. */
export function formatPercent(part: number, total: number): string {
  const denominator = finite(total);
  if (denominator <= 0) return "0%";
  const value = (finite(part) / denominator) * 100;
  if (!Number.isFinite(value)) return "0%";
  return `${trimZeros(value.toFixed(value >= 10 ? 1 : 2))}%`;
}

/** A 0..1 ratio as a percent: formatFraction(0.1234) is "12.3%". */
export function formatFraction(fraction: number, digits = 1): string {
  return `${(finite(fraction) * 100).toFixed(digits)}%`;
}

export function formatCredits(value: number, digits = 2): string {
  return finite(value).toFixed(digits);
}

export function formatUsd(value: number): string {
  const n = finite(value);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

const BYTE_UNITS = ["KB", "MB", "GB"] as const;

export function formatBytes(bytes: number, lang?: Lang): string {
  let value = finite(bytes);
  if (Math.abs(value) < 1024) return `${Math.trunc(value)} B`;
  let unit: (typeof BYTE_UNITS)[number] = "KB";
  for (const next of BYTE_UNITS) {
    unit = next;
    value /= 1024;
    if (Math.abs(value) < 1024) break;
  }
  return `${formatDecimal(value, 1, lang)} ${unit}`;
}

/**
 * Request duration. Rows logged before durations were tracked have no endpoint either, so a
 * missing value without an endpoint is "—", while a real 0 ms request still shows "0 ms".
 */
export function formatDurationMs(ms: number | undefined, hasEndpoint: boolean): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || (!value && !hasEndpoint)) return EMPTY;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
  const totalSec = Math.round(value / 1000);
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

const UPTIME_UNITS: Record<Lang, { d: string; h: string; min: string }> = {
  en: { d: "d", h: "h", min: "min" },
  zh: { d: "天", h: "小时", min: "分钟" },
};

/** "3 d 4 h", "4 h 12 min" or "12 min". */
export function formatUptime(seconds: number, lang: Lang): string {
  const units = UPTIME_UNITS[lang] ?? UPTIME_UNITS.en;
  const total = Math.max(0, Math.floor(finite(seconds)));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} ${units.d} ${hours} ${units.h}`;
  if (hours > 0) return `${hours} ${units.h} ${minutes} ${units.min}`;
  return `${minutes} ${units.min}`;
}

export function unixToDate(unixSec: number): Date {
  return new Date(unixSec * 1000);
}

/** Medium date and short time in the active language. */
export function formatDateTime(unixSec: number, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "medium", timeStyle: "short" }).format(
    unixToDate(finite(unixSec)),
  );
}

/** Short time in the active language. */
export function formatTime(unixSec: number, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { timeStyle: "short" }).format(
    unixToDate(finite(unixSec)),
  );
}

// [unit, seconds per unit, use this unit while |diff| is below this many seconds]
const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number, number]> = [
  ["second", 1, 60],
  ["minute", 60, 3600],
  ["hour", 3600, 86_400],
  ["day", 86_400, 86_400 * 30],
  ["month", 86_400 * 30, 86_400 * 365],
  ["year", 86_400 * 365, Number.POSITIVE_INFINITY],
];

/** "5 minutes ago", "yesterday", "in 3 days" (numeric: 'auto'). */
export function formatRelativeTime(
  unixSec: number,
  lang: Lang,
  nowMs: number = Date.now(),
): string {
  const diff = finite(unixSec) - nowMs / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const [unit, size] =
    RELATIVE_STEPS.find(([, , limit]) => Math.abs(diff) < limit) ?? RELATIVE_STEPS[0];
  return rtf.format(Math.round(diff / size), unit);
}

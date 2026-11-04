import { getActiveLang, intlLocale, type Lang } from "@/lib/i18n";

/**
 * Number, date and duration formatting through Intl in the UI language. Every formatter takes
 * an optional language; without one it uses the active UI language (the I18nProvider's).
 */

export const EMPTY = "—";

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function locale(lang?: Lang): string {
  return intlLocale(lang ?? getActiveLang());
}

/** A cached Intl.NumberFormat for the language and options. */
export function numberFormat(lang: Lang | undefined, options: Intl.NumberFormatOptions = {}) {
  const tag = locale(lang);
  const id = `${tag}|${JSON.stringify(options)}`;
  let format = numberFormats.get(id);
  if (!format) {
    format = new Intl.NumberFormat(tag, options);
    numberFormats.set(id, format);
  }
  return format;
}

/** A cached Intl.DateTimeFormat for the language and options. */
export function dateTimeFormat(
  lang: Lang | undefined,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  const tag = locale(lang);
  const id = `${tag}|${JSON.stringify(options)}`;
  let format = dateFormats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(tag, options);
    dateFormats.set(id, format);
  }
  return format;
}

function finite(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Grouped integer (truncated toward zero). */
export function formatNumber(value: number, lang?: Lang): string {
  return numberFormat(lang, { maximumFractionDigits: 0 }).format(Math.trunc(finite(value)));
}

export function formatDecimal(value: number, digits: number, lang?: Lang): string {
  return numberFormat(lang, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(finite(value));
}

/** Compact notation with at most one decimal: 999, 1K, 1.2K, 3.4M in English. */
export function formatCompact(value: number, lang?: Lang): string {
  const n = finite(value);
  if (Math.abs(n) < 1000) return formatNumber(n, lang);
  return numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** part/total as a percent: 1 decimal from 10 % up, else 2, trailing zeros dropped. */
export function formatPercent(part: number, total: number, lang?: Lang): string {
  const denominator = finite(total);
  const ratio = denominator > 0 ? finite(part) / denominator : 0;
  const value = Number.isFinite(ratio) ? ratio : 0;
  return numberFormat(lang, {
    style: "percent",
    maximumFractionDigits: value * 100 >= 10 ? 1 : 2,
  }).format(value);
}

/** A 0..1 ratio as a percent with fixed decimals: formatFraction(0.1234) is "12.3%". */
export function formatFraction(fraction: number, digits = 1, lang?: Lang): string {
  return numberFormat(lang, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(finite(fraction));
}

/** True when `value` is above zero but would show as zero with `digits` decimals. */
export function roundsToZero(value: number, digits: number): boolean {
  const n = finite(value);
  return n > 0 && n < 0.5 * 10 ** -digits;
}

/** "<0.01" for `digits` 2: the smallest step at that precision, for an amount below it. */
export function belowStep(digits: number, lang?: Lang): string {
  return `<${formatDecimal(10 ** -digits, digits, lang)}`;
}

/**
 * Credits with `digits` decimals: 0.25 → "0.25". An amount above zero that would round to zero
 * reads "<0.01" instead, so a tiny charge never looks free; zero stays "0.00".
 */
export function formatCredits(value: number, digits = 2, lang?: Lang): string {
  if (roundsToZero(value, digits)) return belowStep(digits, lang);
  return formatDecimal(value, digits, lang);
}

/** The exact amount behind a "<0.01", to six significant digits: 0.0001234 → "0.0001234". */
export function formatCreditsExact(value: number, lang?: Lang): string {
  return numberFormat(lang, { maximumSignificantDigits: 6 }).format(finite(value));
}

export function formatUsd(value: number, lang?: Lang): string {
  return numberFormat(lang, { style: "currency", currency: "USD" }).format(finite(value));
}

function formatUnit(
  value: number,
  unit: string,
  lang: Lang | undefined,
  digits = 0,
  display: "short" | "narrow" = "short",
): string {
  return numberFormat(lang, {
    style: "unit",
    unit,
    unitDisplay: display,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte"] as const;

/** 512 B, 47.1 kB, 5.0 MB: binary steps, one decimal from a kilobyte up. */
export function formatBytes(bytes: number, lang?: Lang): string {
  let value = finite(bytes);
  if (Math.abs(value) < 1024) return formatUnit(Math.trunc(value), "byte", lang, 0, "narrow");
  let unit: (typeof BYTE_UNITS)[number] = "kilobyte";
  for (const next of BYTE_UNITS) {
    unit = next;
    value /= 1024;
    // Round first so 1023.96 KB becomes 1.0 MB instead of "1,024.0 KB".
    if (Math.abs(Math.round(value * 10) / 10) < 1024) break;
  }
  return formatUnit(value, unit, lang, 1);
}

/**
 * Request duration. Rows logged before durations were tracked have no endpoint either, so a
 * missing value without an endpoint is "—", while a real 0 ms request still shows "0 ms".
 */
export function formatDurationMs(
  ms: number | undefined,
  hasEndpoint: boolean,
  lang?: Lang,
): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || (!value && !hasEndpoint)) return EMPTY;
  if (value < 1000) return formatUnit(Math.round(value), "millisecond", lang, 0, "narrow");
  // Rounded to the shown precision first, so 59 960 ms is "1m 0s" and not "60.0 s".
  const seconds = value / 1000;
  const digits = seconds < 10 ? 2 : 1;
  const shown = Math.round(seconds * 10 ** digits) / 10 ** digits;
  if (shown < 60) return formatUnit(shown, "second", lang, shown < 10 ? 2 : 1, "narrow");
  const totalSec = Math.round(seconds);
  return joinUnits(
    [
      [Math.floor(totalSec / 60), "minute"],
      [totalSec % 60, "second"],
    ],
    lang,
  );
}

function joinUnits(parts: [number, string][], lang: Lang | undefined): string {
  return parts.map(([value, unit]) => formatUnit(value, unit, lang, 0, "narrow")).join(" ");
}

/** "3d 4h", "4h 12m" or "12m" in English; the units follow the UI language. */
export function formatUptime(seconds: number, lang?: Lang): string {
  const total = Math.max(0, Math.floor(finite(seconds)));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return joinUnits(
      [
        [days, "day"],
        [hours, "hour"],
      ],
      lang,
    );
  }
  if (hours > 0) {
    return joinUnits(
      [
        [hours, "hour"],
        [minutes, "minute"],
      ],
      lang,
    );
  }
  return joinUnits([[minutes, "minute"]], lang);
}

export function unixToDate(unixSec: number): Date {
  return new Date(unixSec * 1000);
}

/** Medium date and short time in the active language. */
export function formatDateTime(unixSec: number, lang?: Lang): string {
  return dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
    unixToDate(finite(unixSec)),
  );
}

/** Short time in the active language. */
export function formatTime(unixSec: number, lang?: Lang): string {
  return dateTimeFormat(lang, { timeStyle: "short" }).format(unixToDate(finite(unixSec)));
}

/** Time with seconds (a log line timestamp) in the active language. */
export function formatClockTime(date: Date, lang?: Lang): string {
  return dateTimeFormat(lang, { timeStyle: "medium" }).format(date);
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
  lang?: Lang,
  nowMs: number = Date.now(),
): string {
  const diff = finite(unixSec) - nowMs / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const [unit, size] =
    RELATIVE_STEPS.find(([, , limit]) => Math.abs(diff) < limit) ?? RELATIVE_STEPS[0];
  return rtf.format(Math.round(diff / size), unit);
}

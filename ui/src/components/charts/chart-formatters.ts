import { dateTimeFormat, numberFormat } from "@/lib/format";

// Formatters in the active UI language: each call resolves the cached Intl formatter for it.
function dateFormatter(options: Intl.DateTimeFormatOptions): {
  format: (date: Date | number) => string;
} {
  return { format: (date) => dateTimeFormat(undefined, options).format(date) };
}

export const shortDateFmt = dateFormatter({ month: "short", day: "numeric" });

export const weekdayDateFmt = dateFormatter({ weekday: "short", month: "short", day: "numeric" });

export const intFmt = (value: number): string => numberFormat(undefined).format(value);
export const valueLabelFmt = (value: number): string =>
  numberFormat(undefined, { maximumFractionDigits: 0 }).format(value);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Tooltip value for a `<Band>` row: `"low – high"` (ordered), the value itself
 * when both edges read the same key, or `null` when either edge is missing
 * (e.g. Bollinger warm-up rows).
 */
export function formatBandRange(
  point: Record<string, unknown>,
  upperKey: string,
  lowerKey: string,
  format: (value: number) => string = intFmt,
): string | number | null {
  const upper = point[upperKey];
  const lower = point[lowerKey];
  if (!(isFiniteNumber(upper) && isFiniteNumber(lower))) {
    return null;
  }
  if (upperKey === lowerKey) {
    return upper;
  }
  return `${format(Math.min(lower, upper))} – ${format(Math.max(lower, upper))}`;
}

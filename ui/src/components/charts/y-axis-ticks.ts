import { numberFormat } from "@/lib/format";
import type { Lang } from "@/lib/i18n";

export const Y_AXIS_DEFAULT_TICK_COUNT = 5;

/** Minimum valid `numTicks` for `scale.ticks()` — values ≤ 0 yield no ticks. */
const Y_AXIS_MIN_TICK_COUNT = 1;

/**
 * Upper bound for the tick count hint. D3 may return more "nice" ticks above ~10;
 * keeping the hint in a modest range avoids overcrowded axes.
 */
const Y_AXIS_MAX_TICK_COUNT = 10;

/** Clamps a user `numTicks` value to a valid d3 tick-count hint. */
export function resolveYAxisTickCount(numTicks?: number): number {
  if (numTicks == null || !Number.isFinite(numTicks)) {
    return Y_AXIS_DEFAULT_TICK_COUNT;
  }
  const rounded = Math.round(numTicks);
  if (rounded < Y_AXIS_MIN_TICK_COUNT) {
    return Y_AXIS_MIN_TICK_COUNT;
  }
  if (rounded > Y_AXIS_MAX_TICK_COUNT) {
    return Y_AXIS_MAX_TICK_COUNT;
  }
  return rounded;
}

/**
 * A YAxis's labels for `values`. Plain numbers keep as many decimals as the tick step needs, so
 * neighbouring ticks never read the same: a step of 0.002 shows "0.002", "0.004", not "0", "0".
 * `formatLargeNumbers` compacts 1,000 and up ("1.5K"); `formatValue` replaces both.
 */
export function tickLabels(
  values: readonly number[],
  formatLargeNumbers: boolean,
  formatValue?: (value: number) => string,
  lang?: Lang,
): string[] {
  if (formatValue) {
    return values.map(formatValue);
  }
  const step = values.length > 1 ? Math.abs(values[1] - values[0]) : 0;
  const plain = numberFormat(lang, {
    maximumFractionDigits: step > 0 ? Math.max(2, Math.ceil(-Math.log10(step))) : 2,
  });
  const compact = numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  return values.map((value) =>
    (formatLargeNumbers && Math.abs(value) >= 1000 ? compact : plain).format(value),
  );
}

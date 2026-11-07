import {
  type CurveFactory,
  curveLinear,
  curveMonotoneX,
  curveNatural,
  curveStep,
  area as d3Area,
  line as d3Line,
} from "d3-shape";
import { translate } from "@/lib/i18n";

export type SparklineCurve = "linear" | "monotone" | "natural" | "step";

export type SparklineDataKey<T> = keyof T | ((datum: T, index: number) => number);

export interface SparklinePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SparklinePoint {
  x: number;
  y: number;
  /** NaN when the source value is missing. */
  value: number;
}

export interface SparklineLayout {
  points: SparklinePoint[];
  /** Pixel y of the baseline (0, clamped into the domain). */
  baselineY: number;
  domain: [number, number];
}

const curves: Record<SparklineCurve, CurveFactory> = {
  linear: curveLinear,
  monotone: curveMonotoneX,
  natural: curveNatural,
  step: curveStep,
};

export function resolveSparklinePadding(
  padding: number | Partial<SparklinePadding> | undefined,
  fallback: number,
): SparklinePadding {
  if (typeof padding === "number" || padding === undefined) {
    const p = padding ?? fallback;
    return { top: p, right: p, bottom: p, left: p };
  }
  return {
    top: padding.top ?? fallback,
    right: padding.right ?? fallback,
    bottom: padding.bottom ?? fallback,
    left: padding.left ?? fallback,
  };
}

export function resolveSparklineValues<T>(
  data: readonly T[],
  dataKey: SparklineDataKey<T>,
): number[] {
  return data.map((datum, index) => {
    const raw =
      typeof dataKey === "function"
        ? dataKey(datum, index)
        : (datum as Record<PropertyKey, unknown>)[dataKey as PropertyKey];
    const value = typeof raw === "number" ? raw : Number(raw);
    return raw === null || raw === undefined ? Number.NaN : value;
  });
}

/** Value domain for the sparkline: it hugs the data unless `yDomain` pins an end. */
export function computeSparklineDomain(
  values: readonly number[],
  options: { yDomain?: [number?, number?] } = {},
): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value)) {
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
  }
  if (min === Number.POSITIVE_INFINITY) {
    min = 0;
    max = 0;
  }
  min = options.yDomain?.[0] ?? min;
  max = options.yDomain?.[1] ?? max;
  if (min === max) {
    // Flat series: centre the line instead of pinning it to an edge.
    return [min - 1, max + 1];
  }
  return [min, max];
}

export function computeSparklineLayout(
  values: readonly number[],
  options: {
    width: number;
    height: number;
    padding: SparklinePadding;
    domain: [number, number];
  },
): SparklineLayout {
  const { width, height, padding, domain } = options;
  const innerWidth = Math.max(0, width - padding.left - padding.right);
  const innerHeight = Math.max(0, height - padding.top - padding.bottom);
  const [d0, d1] = domain;
  const yOf = (value: number) =>
    padding.top + innerHeight - ((value - d0) / (d1 - d0)) * innerHeight;

  const n = values.length;
  const step = n > 1 ? innerWidth / (n - 1) : 0;

  const points = values.map((value, i) => ({
    x: padding.left + (n > 1 ? step * i : innerWidth / 2),
    y: Number.isFinite(value) ? yOf(value) : Number.NaN,
    value,
  }));

  const baseline = Math.min(Math.max(0, d0), d1);
  return { points, baselineY: yOf(baseline), domain };
}

const isDefined = (point: SparklinePoint) => Number.isFinite(point.y);

export function buildSparklineLinePath(
  points: readonly SparklinePoint[],
  curve: SparklineCurve,
): string {
  return (
    d3Line<SparklinePoint>()
      .defined(isDefined)
      .x((p) => p.x)
      .y((p) => p.y)
      .curve(curves[curve])(points as SparklinePoint[]) ?? ""
  );
}

export function buildSparklineAreaPath(
  points: readonly SparklinePoint[],
  curve: SparklineCurve,
  baselineY: number,
): string {
  return (
    d3Area<SparklinePoint>()
      .defined(isDefined)
      .x((p) => p.x)
      .y0(baselineY)
      .y1((p) => p.y)
      .curve(curves[curve])(points as SparklinePoint[]) ?? ""
  );
}

/** Nearest data index for a pointer x position (in chart pixels). */
export function sparklineIndexAtX(
  x: number,
  options: {
    count: number;
    width: number;
    padding: SparklinePadding;
  },
): number | null {
  const { count, width, padding } = options;
  if (count === 0) {
    return null;
  }
  const innerWidth = width - padding.left - padding.right;
  if (innerWidth <= 0) {
    return 0;
  }
  const t = (x - padding.left) / innerWidth;
  const raw = Math.round(t * (count - 1));
  return Math.min(count - 1, Math.max(0, raw));
}

function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Message lookup for the summary; keys are `sparkline.*` in the `ui` namespace. */
type SparklineTranslate = (
  key: "sparkline.empty" | "sparkline.summary" | "sparkline.summaryUp" | "sparkline.summaryDown",
  params?: Record<string, string | number>,
) => string;

const englishSummary: SparklineTranslate = (key, params) => translate("en", "ui", key, params);

/**
 * Screen-reader summary, e.g. "12 points, from 3.1K to 4.2K, up 35%". Pass the UI language's
 * `t` and locale so the summary is read in that language; English is the fallback.
 */
export function describeSparkline(
  values: readonly number[],
  t: SparklineTranslate = englishSummary,
  locale = "en",
): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return t("sparkline.empty");
  }
  const first = finite[0] as number;
  const last = finite.at(-1) as number;
  const params = {
    count: finite.length,
    first: formatCompact(first, locale),
    last: formatCompact(last, locale),
  };
  if (first === 0) {
    return t("sparkline.summary", params);
  }
  const change = ((last - first) / Math.abs(first)) * 100;
  return t(change >= 0 ? "sparkline.summaryUp" : "sparkline.summaryDown", {
    ...params,
    change: Math.abs(Math.round(change)),
  });
}

/**
 * Tween frame between two layouts. Points take the target x; the previous
 * shape is resampled onto the target grid so series of different lengths
 * rise and fall into place. Missing values snap.
 */
export function interpolateSparklineLayout(
  from: SparklineLayout,
  to: SparklineLayout,
  t: number,
): SparklineLayout {
  const m = from.points.length;
  const n = to.points.length;
  const fromYAt = (i: number): number => {
    if (m === 0) {
      return Number.NaN;
    }
    if (m === n) {
      return from.points[i]?.y ?? Number.NaN;
    }
    const position = n > 1 ? (i / (n - 1)) * (m - 1) : 0;
    const lo = Math.floor(position);
    const a = from.points[lo]?.y ?? Number.NaN;
    const b = from.points[Math.min(m - 1, lo + 1)]?.y ?? Number.NaN;
    return a + (b - a) * (position - lo);
  };
  return {
    ...to,
    baselineY: from.baselineY + (to.baselineY - from.baselineY) * t,
    points: to.points.map((point, i) => {
      const fromY = fromYAt(i);
      return Number.isFinite(fromY) && Number.isFinite(point.y)
        ? { ...point, y: fromY + (point.y - fromY) * t }
        : point;
    }),
  };
}

import type { AccountHeatmap, HeatmapCell, HeatmapData, ModelMixEntry } from "@/lib/api/types";
import type { OverviewRange } from "@/routes/-search";

/** Heatmap window and bucket size per traffic-chart range: 60, 72 and 96 points. */
export const RANGE_WINDOWS: Readonly<
  Record<OverviewRange, { windowMin: number; bucketMin: number }>
> = {
  "1h": { windowMin: 60, bucketMin: 1 },
  "6h": { windowMin: 360, bucketMin: 5 },
  "24h": { windowMin: 1440, bucketMin: 15 },
};

/** Status-card deltas and the account heatmap share this two-hour window. */
export const HOUR_PAIR_WINDOW = 120;
export const HOUR = 60;

export interface TrafficPoint {
  date: Date;
  succeeded: number;
  failed: number;
}

export type CellValue = (cell: HeatmapCell) => number;

const requests: CellValue = (cell) => cell.reqs;

/**
 * Sums newest-first per-minute cells into oldest-first buckets of `bucketMin` minutes. A
 * bucket's date is the start of its oldest minute: `nowUnix - offset * 60`.
 */
export function bucketGlobal(
  cells: readonly HeatmapCell[],
  nowUnix: number,
  bucketMin: number,
): TrafficPoint[] {
  const size = Math.max(1, Math.floor(bucketMin));
  const count = Math.ceil(cells.length / size);
  const points = Array.from({ length: count }, (_, index) => {
    // index 0 is the oldest bucket; its oldest minute has the largest offset.
    const oldestOffset = (count - index) * size - 1;
    return {
      date: new Date((nowUnix - oldestOffset * 60) * 1000),
      succeeded: 0,
      failed: 0,
    };
  });
  for (const cell of cells) {
    const bucket = Math.floor(cell.offset / size);
    if (cell.offset < 0 || bucket >= count) continue;
    const point = points[count - 1 - bucket];
    point.failed += cell.failures;
    point.succeeded += Math.max(0, cell.reqs - cell.failures);
  }
  return points;
}

export interface HourDelta {
  current: number;
  previous: number;
  /** (current - previous) / previous; null when the previous hour is 0. */
  delta: number | null;
}

/** Offsets 0-59 are the current hour, 60-119 the previous one. */
export function hourDelta(cells: readonly HeatmapCell[], value: CellValue = requests): HourDelta {
  let current = 0;
  let previous = 0;
  for (const cell of cells) {
    if (cell.offset < 0) continue;
    if (cell.offset < HOUR) current += value(cell);
    else if (cell.offset < 2 * HOUR) previous += value(cell);
  }
  return { current, previous, delta: previous === 0 ? null : (current - previous) / previous };
}

/** The current hour as 12 oldest-first 5-minute buckets, for the stat-card sparklines. */
export function sparklineBuckets(
  cells: readonly HeatmapCell[],
  value: CellValue = requests,
): { value: number }[] {
  const bucketMin = 5;
  const count = HOUR / bucketMin;
  const buckets = Array.from({ length: count }, () => ({ value: 0 }));
  for (const cell of cells) {
    if (cell.offset < 0 || cell.offset >= HOUR) continue;
    buckets[count - 1 - Math.floor(cell.offset / bucketMin)].value += value(cell);
  }
  return buckets;
}

function score(row: AccountHeatmap, windowMin: number): number {
  let total = 0;
  for (const cell of row.cells) {
    if (cell.offset >= 0 && cell.offset < windowMin) total += cell.reqs + cell.failures;
  }
  return total;
}

/**
 * The busiest accounts by Σ(reqs + failures) over offsets below `windowMin`. Accounts without
 * traffic in the window are left out; `rest` counts the busy ones that did not fit.
 */
export function topAccounts(
  heatmap: Pick<HeatmapData, "accounts">,
  limit: number,
  windowMin: number = Number.POSITIVE_INFINITY,
): { rows: AccountHeatmap[]; rest: number } {
  const busy = heatmap.accounts
    .map((row) => ({ row, score: score(row, windowMin) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    rows: busy.slice(0, limit).map((entry) => entry.row),
    rest: Math.max(0, busy.length - limit),
  };
}

export interface ModelSlice {
  label: string;
  value: number;
  maxValue: number;
}

/**
 * Ring slices: the top `limit` models plus "Other" for the rest. Values are credits, or
 * requests when no model has used credits yet.
 */
export function modelSlices(
  models: readonly ModelMixEntry[],
  limit: number,
  otherLabel: string,
): { slices: ModelSlice[]; total: number; metric: "credits" | "reqs" } {
  const totalCredits = models.reduce((sum, m) => sum + m.credits, 0);
  const metric = totalCredits > 0 ? "credits" : "reqs";
  const metricOf = (m: ModelMixEntry) => (metric === "credits" ? m.credits : m.reqs);
  const sorted = [...models].sort((a, b) => metricOf(b) - metricOf(a));
  const total = metric === "credits" ? totalCredits : models.reduce((sum, m) => sum + m.reqs, 0);
  const slices: ModelSlice[] = sorted
    .slice(0, limit)
    .map((m) => ({ label: m.model, value: metricOf(m), maxValue: total }));
  const rest = sorted.slice(limit).reduce((sum, m) => sum + metricOf(m), 0);
  if (sorted.length > limit) slices.push({ label: otherLabel, value: rest, maxValue: total });
  return { slices, total, metric };
}

/** Heat cell opacity: 0.18 for an empty minute up to 1 for the busiest displayed minute. */
export function cellOpacity(reqs: number, maxReq: number): number {
  return 0.18 + Math.min(1, reqs / Math.max(1, maxReq)) * 0.82;
}

/** Offsets 0..windowMin-1 oldest-first (oldest on the left); missing minutes are zeros. */
export function windowCells(cells: readonly HeatmapCell[], windowMin: number): HeatmapCell[] {
  const byOffset = new Map(cells.map((cell) => [cell.offset, cell]));
  return Array.from({ length: windowMin }, (_, index) => {
    const offset = windowMin - 1 - index;
    const cell = byOffset.get(offset);
    return { offset, reqs: cell?.reqs ?? 0, failures: cell?.failures ?? 0 };
  });
}

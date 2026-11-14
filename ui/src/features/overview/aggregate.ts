import type { HeatmapCell, ModelMixEntry } from "@/lib/api/types";
import type { OverviewRange } from "@/routes/-search";

/** The traffic ranges the live per-minute heatmap covers; All time reads the request log. */
export type HeatmapRange = Exclude<OverviewRange, "all">;

/**
 * Heatmap window and bucket size per traffic-chart range: 30, 72 and 96 points. The 1 h view
 * uses 2-minute buckets because sparse per-minute counts draw as a comb of spikes.
 */
export const RANGE_WINDOWS: Readonly<
  Record<HeatmapRange, { windowMin: number; bucketMin: number }>
> = {
  "1h": { windowMin: 60, bucketMin: 2 },
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
  /** Succeeded requests in the same bucket of the previous window (the dashed comparison). */
  previous?: number;
}

export type CellValue = (cell: HeatmapCell) => number;

const requests: CellValue = (cell) => cell.reqs;

/**
 * Sums newest-first per-minute cells into oldest-first buckets of `bucketMin` minutes. A
 * bucket's date is the start of its oldest minute: `nowUnix - offset * 60`. `windowMin` sets
 * the number of buckets (default: one per cell), so a window with no cells still has its time
 * axis, and cells past it are left out.
 */
export function bucketGlobal(
  cells: readonly HeatmapCell[],
  nowUnix: number,
  bucketMin: number,
  windowMin: number = cells.length,
): TrafficPoint[] {
  const size = Math.max(1, Math.floor(bucketMin));
  const count = Math.ceil(Math.max(0, windowMin) / size);
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

/**
 * Retried upstream attempts per bucket, aligned with `bucketGlobal`'s points (oldest first).
 * The proxy counts a retry apart from the request it belongs to, so these are not part of
 * `reqs`.
 */
export function bucketRetries(
  cells: readonly HeatmapCell[],
  bucketMin: number,
  windowMin: number,
): number[] {
  const size = Math.max(1, Math.floor(bucketMin));
  const count = Math.ceil(Math.max(0, windowMin) / size);
  const retries = Array.from({ length: count }, () => 0);
  for (const cell of cells) {
    const bucket = Math.floor(cell.offset / size);
    if (cell.offset < 0 || bucket >= count) continue;
    retries[count - 1 - bucket] += cell.retries ?? 0;
  }
  return retries;
}

/**
 * The current window with the previous one laid under it: each point also carries the succeeded
 * count of the bucket exactly `windowMin` minutes earlier. `cells` must cover both windows
 * (offsets 0 to 2 x windowMin - 1), as the cached two-hour heatmap does for the 1 h view.
 */
export function withPreviousWindow(
  cells: readonly HeatmapCell[],
  nowUnix: number,
  bucketMin: number,
  windowMin: number,
): TrafficPoint[] {
  const current = bucketGlobal(cells, nowUnix, bucketMin, windowMin);
  const earlier = cells
    .filter((cell) => cell.offset >= windowMin && cell.offset < 2 * windowMin)
    .map((cell) => ({ ...cell, offset: cell.offset - windowMin }));
  const previous = bucketGlobal(earlier, nowUnix, bucketMin, windowMin);
  return current.map((point, index) => ({ ...point, previous: previous[index]?.succeeded ?? 0 }));
}

/** The busiest bucket of any series (succeeded, failed or previous), for the y-axis ticks. */
export function peakCount(points: readonly TrafficPoint[]): number {
  return points.reduce((top, p) => Math.max(top, p.succeeded, p.failed, p.previous ?? 0), 0);
}

interface HourDelta {
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

interface ModelSlice {
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

/**
 * The accounts the server sent for top=N, in its order (busiest first by requests plus failed
 * attempts over the last `windowMin` minutes), at most `limit`. A row with neither in the window
 * is left out, should one come; a row with only failed attempts stays, as the server counts it.
 */
export function busyAccounts<T extends { cells: readonly HeatmapCell[] }>(
  accounts: readonly T[],
  windowMin: number,
  limit: number,
): T[] {
  return accounts
    .filter((account) =>
      account.cells.some(
        (cell) => cell.offset < windowMin && (cell.reqs > 0 || (cell.retries ?? 0) > 0),
      ),
    )
    .slice(0, Math.max(0, limit));
}

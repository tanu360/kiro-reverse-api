import type { HeatmapCell, ModelMixEntry } from "@/lib/api/types";
import type { OverviewRange } from "@/routes/-search";

/**
 * Heatmap window and bucket size per traffic-chart range: 30, 72 and 96 points. The 1 h view
 * uses 2-minute buckets because sparse per-minute counts draw as a comb of spikes.
 */
export const RANGE_WINDOWS: Readonly<
  Record<OverviewRange, { windowMin: number; bucketMin: number }>
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

/** Minutes in the live series (/observe/overview `series`): the last half hour, oldest first. */
const SERIES_MINUTES = 30;

/**
 * Minutes per sparkline bar: the 30 per-minute points become 15 bars, wide enough to read in
 * the 48 to 96 px trend slot. Bars are cut from the newest end, so the last one always holds the
 * current (partial) minute.
 */
const BAR_MINUTES = 2;

export type Bars = { value: number }[];

/**
 * Sums per-minute `values` (oldest first) into BAR_MINUTES-wide bars, oldest first. A short
 * or missing series is padded with empty minutes at the old end, so there are always 15 bars.
 */
export function sumBars(values: readonly number[]): Bars {
  const length = Math.max(values.length, SERIES_MINUTES);
  const missing = length - values.length;
  const bars: Bars = [];
  for (let end = length; end > 0; end -= BAR_MINUTES) {
    let sum = 0;
    for (let index = Math.max(0, end - BAR_MINUTES); index < end; index += 1) {
      sum += values[index - missing] ?? 0;
    }
    bars.unshift({ value: sum });
  }
  return bars;
}

/** Failed requests per minute: requests times that minute's error rate (0..1). */
function failuresPerMinute(rpm: readonly number[], errRate: readonly number[]): number[] {
  return rpm.map((reqs, index) => Math.min(reqs, Math.round(reqs * (errRate[index] ?? 0))));
}

/** The error rate per bar: failures over requests across its minutes (0 for an empty bar). */
export function rateBars(rpm: readonly number[], errRate: readonly number[]): Bars {
  const requests = sumBars(rpm);
  const failures = sumBars(rpm.map((reqs, index) => reqs * (errRate[index] ?? 0)));
  return requests.map((bar, index) => ({
    value: bar.value > 0 ? failures[index].value / bar.value : 0,
  }));
}

/**
 * The KPI strip's bars from the live series: all requests, the ones that succeeded and the ones
 * that failed (requests times the error rate), per bar.
 */
export function outcomeBars(
  rpm: readonly number[],
  errRate: readonly number[],
): { requests: Bars; succeeded: Bars; failed: Bars } {
  const failed = failuresPerMinute(rpm, errRate);
  return {
    requests: sumBars(rpm),
    succeeded: sumBars(rpm.map((reqs, index) => Math.max(0, reqs - failed[index]))),
    failed: sumBars(failed),
  };
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

/** Offsets 0..windowMin-1 oldest-first (oldest on the left); missing minutes are zeros. */
export function windowCells(cells: readonly HeatmapCell[], windowMin: number): HeatmapCell[] {
  const byOffset = new Map(cells.map((cell) => [cell.offset, cell]));
  return Array.from({ length: windowMin }, (_, index) => {
    const offset = windowMin - 1 - index;
    const cell = byOffset.get(offset);
    return {
      offset,
      reqs: cell?.reqs ?? 0,
      failures: cell?.failures ?? 0,
      retries: cell?.retries ?? 0,
    };
  });
}

/**
 * Oldest-first cells merged `size` at a time, still oldest first: counts summed, `offset` the
 * newest minute of each group. Groups are cut from the newest end, so the current minute always
 * shares the last group.
 */
export function mergeCells(cells: readonly HeatmapCell[], size: number): HeatmapCell[] {
  const step = Math.max(1, Math.floor(size));
  const merged: HeatmapCell[] = [];
  for (let end = cells.length; end > 0; end -= step) {
    const group = cells.slice(Math.max(0, end - step), end);
    merged.unshift({
      offset: Math.min(...group.map((cell) => cell.offset)),
      reqs: group.reduce((sum, cell) => sum + cell.reqs, 0),
      failures: group.reduce((sum, cell) => sum + cell.failures, 0),
      retries: group.reduce((sum, cell) => sum + (cell.retries ?? 0), 0),
    });
  }
  return merged;
}

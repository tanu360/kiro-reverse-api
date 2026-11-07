"use client";

import { type CSSProperties, memo, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  selectTooltipData,
  useChartHoverSelector,
  useChartPortalContainer,
  useChartStable,
} from "./chart-context";
import { shortDateFmt } from "./chart-formatters";
import { DEFAULT_Y_DOMAIN_TWEEN_MS } from "./chart-phase";
import { LINE_LOADING_PULSE_EASE } from "./line-loading-timing";
import {
  type ChartLabelCount,
  resolveResponsiveChartLabelCount,
} from "./responsive-chart-label-count";

const X_AXIS_POSITION_TWEEN_MS = DEFAULT_Y_DOMAIN_TWEEN_MS;
/**
 * The label slide while the x domain tweens. Classes apply it and the label fade (not inline
 * styles), so the global reduced-motion and theme-swap overrides win over them.
 */
const LABEL_SLIDE_VAR = {
  "--x-axis-label-slide": `left ${X_AXIS_POSITION_TWEEN_MS}ms cubic-bezier(${LINE_LOADING_PULSE_EASE.join(", ")})`,
} as CSSProperties;

interface XAxisProps {
  /** Number of ticks to show (including first and last). Default: 5. */
  numTicks?: ChartLabelCount;
  /** Half the date ticker pill plus half a label, for the fade calculation. Default: 40 */
  tickerHalfWidth?: number;
  /**
   * `"data"` — tick labels snap to data rows so crosshair and tooltip stay aligned (default).
   * `"domain"` — evenly spaced ticks across the time domain (may not align with hover).
   */
  tickMode?: "domain" | "data";
  /** Optional labels aligned with data rows for the displayed ticks. */
  labels?: string[];
  /**
   * Explicit tick dates, e.g. round times from {@link roundTimeTicks}. Each date gets a tick at
   * its own x (it need not be a data row); dates outside the x domain are dropped. Overrides
   * `numTicks`, `tickMode` and `tickFilter`.
   */
  tickValues?: readonly Date[];
  /**
   * Data rows allowed to carry a tick (data mode). Every row it keeps gets a tick, so `numTicks`
   * no longer thins them; rows with a label already shown are skipped.
   */
  tickFilter?: (row: Record<string, unknown>, index: number) => boolean;
  /** Tick label. Default: `labels` / the chart's date labels, else the short date. */
  formatTick?: (date: Date) => string;
  /**
   * Keeps edge labels whole: `"container"` (default) stops them at the chart's outer edges,
   * `"plot"` at the plot area (clear of y labels in the margins), `"none"` centres every
   * label on its tick even when that cuts it off.
   */
  clamp?: "container" | "plot" | "none";
}

/**
 * Local-time round ticks in `[start, end]`: every `stepMinutes` from midnight (15 -> :00, :15,
 * :30, :45; 60 -> each hour; 240 -> 00:00, 04:00, ...). Pass to `XAxis tickValues`.
 */
export function roundTimeTicks(start: Date, end: Date, stepMinutes: number): Date[] {
  const step = Math.max(1, Math.round(stepMinutes));
  const endTime = end.getTime();
  if (!(Number.isFinite(start.getTime()) && Number.isFinite(endTime))) {
    return [];
  }
  const tick = new Date(start.getTime());
  if (tick.getSeconds() !== 0 || tick.getMilliseconds() !== 0) {
    tick.setSeconds(60, 0);
  }
  const offset = (tick.getHours() * 60 + tick.getMinutes()) % step;
  if (offset !== 0) {
    tick.setMinutes(tick.getMinutes() + step - offset);
  }
  const ticks: Date[] = [];
  while (tick.getTime() <= endTime && ticks.length < 1000) {
    ticks.push(new Date(tick.getTime()));
    tick.setMinutes(tick.getMinutes() + step);
  }
  return ticks;
}

interface AxisTick {
  date: Date;
  x: number;
  label: string;
}

interface XAxisLabelProps {
  label: string;
  x: number;
  /** Fades out near the crosshair; see {@link xAxisLabelOpacity}. */
  opacity: number;
  animatePosition: boolean;
  /** Container-px range the label must stay inside, or null to always centre it. */
  bounds: readonly [number, number] | null;
}

/**
 * Centres the label on its tick, shifted just enough to stay inside `bounds`. The percentages
 * are the label's own width, so no measuring is needed; the left bound wins when both bind.
 */
function labelShift(x: number, bounds: readonly [number, number] | null) {
  if (!bounds) {
    return "translateX(-50%)";
  }
  const [min, max] = bounds;
  return `translateX(clamp(${min - x}px, -50%, calc(${max - x}px - 100%)))`;
}

/**
 * Label opacity while hovering: hidden under the date ticker (or when it shows
 * the same label), fading back in over `fadeBuffer` px beyond it.
 */
function xAxisLabelOpacity(
  label: string,
  x: number,
  crosshairX: number | null,
  hoveredLabel: string | null,
  tickerHalfWidth: number,
): number {
  if (crosshairX === null) {
    return 1;
  }
  const fadeBuffer = 20;
  const fadeRadius = tickerHalfWidth + fadeBuffer;
  const distance = Math.abs(x - crosshairX);
  if (distance < tickerHalfWidth) {
    return 0;
  }
  if (hoveredLabel && label === hoveredLabel) {
    return 0;
  }
  if (distance < fadeRadius) {
    return (distance - tickerHalfWidth) / fadeBuffer;
  }
  return 1;
}

// Memoised on its resolved opacity: a pointer move re-renders only the labels
// whose fade changes, not every label.
const XAxisLabel = memo(function XAxisLabel({
  label,
  x,
  opacity,
  animatePosition,
  bounds,
}: XAxisLabelProps) {
  return (
    <div
      className={
        animatePosition
          ? "absolute whitespace-nowrap [transition:var(--x-axis-label-slide)]"
          : "absolute whitespace-nowrap"
      }
      style={{
        ...LABEL_SLIDE_VAR,
        left: x,
        bottom: 12,
        transform: labelShift(x, bounds),
      }}
    >
      <span className="chart-tick block [transition:opacity_0.4s_ease-in-out]" style={{ opacity }}>
        {label}
      </span>
    </div>
  );
});

const MAX_GAP_LAYOUTS = 400;

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/** All ways to split `span` into `parts` positive integer gaps. */
function composePositiveSum(sum: number, parts: number): number[][] {
  if (parts === 1) {
    return sum >= 1 ? [[sum]] : [];
  }

  const layouts: number[][] = [];
  for (let gap = 1; gap <= sum - (parts - 1); gap++) {
    for (const tail of composePositiveSum(sum - gap, parts - 1)) {
      layouts.push([gap, ...tail]);
    }
  }
  return layouts;
}

function gapsToIndices(gaps: number[]): number[] {
  const indices = [0];
  let position = 0;
  for (const gap of gaps) {
    position += gap;
    indices.push(position);
  }
  return indices;
}

function indicesForTickCount(length: number, tickCount: number): number[] {
  const span = length - 1;
  if (span <= 0) {
    return [0];
  }

  const rawIndices = Array.from({ length: tickCount }, (_, index) =>
    Math.round((index / (tickCount - 1)) * span),
  );

  const indices = [...new Set(rawIndices)].sort((a, b) => a - b);
  if (indices[0] !== 0) {
    indices.unshift(0);
  }
  if (indices.at(-1) !== span) {
    indices.push(span);
  }

  return [...new Set(indices)].sort((a, b) => a - b);
}

function allIndexLayouts(length: number, tickCount: number): number[][] {
  const span = length - 1;
  if (span <= 0) {
    return [[0]];
  }

  const gapCount = tickCount - 1;
  if (gapCount <= 0) {
    return [[0]];
  }

  const layoutCount = binomial(span - 1, gapCount - 1);
  if (layoutCount > MAX_GAP_LAYOUTS) {
    return [indicesForTickCount(length, tickCount)];
  }

  return composePositiveSum(span, gapCount).map(gapsToIndices);
}

function dedupeIndicesByLabel(
  indices: number[],
  data: Record<string, unknown>[],
  dateLabels: string[],
  xAccessor: (d: Record<string, unknown>) => Date,
): number[] {
  const seenLabels = new Set<string>();
  const deduped: number[] = [];

  for (const index of indices) {
    const point = data[index];
    if (!point) {
      continue;
    }
    const label = dateLabels[index] ?? shortDateFmt.format(xAccessor(point));
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    deduped.push(index);
  }

  return deduped;
}

interface TickLayoutScore {
  score: number;
  symmetryPenalty: number;
  countDistance: number;
  /** 0 = smallest gap at end, 1 = at start, 2 = in the middle */
  edgePreference: number;
}

function indexGaps(indices: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < indices.length; i++) {
    const current = indices[i];
    const previous = indices[i - 1];
    if (current == null || previous == null) {
      continue;
    }
    gaps.push(current - previous);
  }
  return gaps;
}

function smallestGapEdgePreference(indices: number[]): number {
  const gaps = indexGaps(indices);
  const smallestGap = Math.min(...gaps);
  const smallestGapIndex = gaps.indexOf(smallestGap);
  if (smallestGapIndex === gaps.length - 1) {
    return 0;
  }
  if (smallestGapIndex === 0) {
    return 1;
  }
  return 2;
}

function scoreTickLayout(
  indices: number[],
  resolveXPx: (index: number) => number,
  targetCount: number,
): TickLayoutScore {
  if (indices.length < 2) {
    return {
      score: Number.POSITIVE_INFINITY,
      symmetryPenalty: Number.POSITIVE_INFINITY,
      countDistance: Number.POSITIVE_INFINITY,
      edgePreference: Number.POSITIVE_INFINITY,
    };
  }

  const pixelGaps: number[] = [];
  for (let i = 1; i < indices.length; i++) {
    const current = indices[i];
    const previous = indices[i - 1];
    if (current == null || previous == null) {
      continue;
    }
    pixelGaps.push(resolveXPx(current) - resolveXPx(previous));
  }

  const minGap = Math.min(...pixelGaps);
  const maxGap = Math.max(...pixelGaps);
  const meanGap = pixelGaps.reduce((sum, gap) => sum + gap, 0) / pixelGaps.length;
  const spreadRatio = meanGap > 0 ? (maxGap - minGap) / meanGap : maxGap - minGap;
  const countDistance = Math.abs(indices.length - targetCount);

  const gaps = indexGaps(indices);
  const smallestGap = Math.min(...gaps);
  const smallestGapIndex = gaps.indexOf(smallestGap);
  const interiorPenalty = smallestGapIndex > 0 && smallestGapIndex < gaps.length - 1 ? 0.08 : 0;

  const symmetryPenalty =
    gaps.reduce((penalty, gap, index) => {
      return penalty + Math.abs(gap - (gaps.at(-1 - index) ?? gap));
    }, 0) / gaps.length;

  return {
    score: spreadRatio + 0.1 * countDistance + interiorPenalty + symmetryPenalty * 0.02,
    symmetryPenalty,
    countDistance,
    edgePreference: smallestGapEdgePreference(indices),
  };
}

function isBetterTickLayout(
  next: TickLayoutScore,
  best: TickLayoutScore,
  nextCountDistance: number,
  bestCountDistance: number,
): boolean {
  if (next.score < best.score - 1e-6) {
    return true;
  }
  if (Math.abs(next.score - best.score) > 1e-6) {
    return false;
  }
  if (nextCountDistance < bestCountDistance) {
    return true;
  }
  if (nextCountDistance > bestCountDistance) {
    return false;
  }
  if (next.symmetryPenalty < best.symmetryPenalty - 1e-6) {
    return true;
  }
  if (next.symmetryPenalty > best.symmetryPenalty + 1e-6) {
    return false;
  }
  return next.edgePreference < best.edgePreference;
}

/**
 * Picks tick indices with the most even on-screen spacing. Tries
 * `targetCount ± 1` and evaluates every gap layout when feasible.
 */
function selectEvenlySpacedIndices(
  length: number,
  targetCount: number,
  options?: {
    data?: Record<string, unknown>[];
    dateLabels?: string[];
    xAccessor?: (d: Record<string, unknown>) => Date;
    resolveXPx?: (index: number) => number;
  },
): number[] {
  if (length <= 0) {
    return [];
  }
  if (length === 1) {
    return [0];
  }
  if (length <= targetCount) {
    return Array.from({ length }, (_, index) => index);
  }

  const resolveXPx = options?.resolveXPx ?? ((index: number) => index);

  const minCount = Math.max(2, targetCount - 1);
  const maxCount = Math.min(length, targetCount + 1);

  let bestIndices = indicesForTickCount(length, targetCount);
  let bestScore = scoreTickLayout(bestIndices, resolveXPx, targetCount);
  let bestCountDistance = bestScore.countDistance;

  for (let tickCount = minCount; tickCount <= maxCount; tickCount++) {
    for (const rawIndices of allIndexLayouts(length, tickCount)) {
      const indices =
        options?.data && options.dateLabels && options.xAccessor
          ? dedupeIndicesByLabel(rawIndices, options.data, options.dateLabels, options.xAccessor)
          : rawIndices;

      if (indices.length < 2) {
        continue;
      }

      const layoutScore = scoreTickLayout(indices, resolveXPx, targetCount);
      const countDistance = Math.abs(indices.length - targetCount);

      if (isBetterTickLayout(layoutScore, bestScore, countDistance, bestCountDistance)) {
        bestIndices = indices;
        bestScore = layoutScore;
        bestCountDistance = countDistance;
      }
    }
  }

  return bestIndices;
}

function buildDataAlignedTicks({
  data,
  dateLabels,
  marginLeft,
  targetTickCount,
  xAccessor,
  xScale,
}: {
  data: Record<string, unknown>[];
  dateLabels: string[];
  marginLeft: number;
  targetTickCount: number;
  xAccessor: (d: Record<string, unknown>) => Date;
  xScale: (date: Date) => number | undefined;
}): AxisTick[] {
  const seenLabels = new Set<string>();
  const ticks: AxisTick[] = [];

  const resolveXPx = (index: number) => {
    const point = data[index];
    if (!point) {
      return index;
    }
    return xScale(xAccessor(point)) ?? 0;
  };

  for (const index of selectEvenlySpacedIndices(data.length, targetTickCount, {
    data,
    dateLabels,
    resolveXPx,
    xAccessor,
  })) {
    const point = data[index];
    if (!point) {
      continue;
    }
    const date = xAccessor(point);
    const label = dateLabels[index] ?? shortDateFmt.format(date);
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    ticks.push({
      date,
      label,
      x: (xScale(date) ?? 0) + marginLeft,
    });
  }

  return ticks;
}

function buildDomainTicks({
  marginLeft,
  numTicks,
  xScale,
  format = (date) => shortDateFmt.format(date),
}: {
  marginLeft: number;
  numTicks: number;
  format?: (date: Date) => string;
  xScale: {
    domain: () => Date[];
    (date: Date): number | undefined;
  };
}): AxisTick[] {
  const domain = xScale.domain();
  const startDate = domain[0];
  const endDate = domain[1];

  if (!(startDate && endDate)) {
    return [];
  }

  const startTime = startDate.getTime();
  const endTime = endDate.getTime();
  const timeRange = endTime - startTime;
  const tickCount = Math.max(2, numTicks);
  const seenLabels = new Set<string>();
  const ticks: AxisTick[] = [];

  for (let i = 0; i < tickCount; i++) {
    const t = i / (tickCount - 1);
    const date = new Date(startTime + t * timeRange);
    const label = format(date);
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    ticks.push({
      date,
      label,
      x: (xScale(date) ?? 0) + marginLeft,
    });
  }

  return ticks;
}

/** One tick per date inside the x domain, labelled by `format`; repeated labels are dropped. */
function buildValueTicks({
  format,
  marginLeft,
  tickValues,
  xScale,
}: {
  format: (date: Date) => string;
  marginLeft: number;
  tickValues: readonly Date[];
  xScale: {
    domain: () => Date[];
    (date: Date): number | undefined;
  };
}): AxisTick[] {
  const [start, end] = xScale.domain();
  if (!(start && end)) {
    return [];
  }
  const seenLabels = new Set<string>();
  const ticks: AxisTick[] = [];
  for (const date of tickValues) {
    const time = date.getTime();
    if (!(time >= start.getTime() && time <= end.getTime())) {
      continue;
    }
    const label = format(date);
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    ticks.push({ date, label, x: (xScale(date) ?? 0) + marginLeft });
  }
  return ticks;
}

/** One tick per data row `keep` accepts; rows whose label is already shown are skipped. */
function buildFilteredTicks({
  data,
  dateLabels,
  keep,
  marginLeft,
  xAccessor,
  xScale,
}: {
  data: Record<string, unknown>[];
  dateLabels: string[];
  keep: (row: Record<string, unknown>, index: number) => boolean;
  marginLeft: number;
  xAccessor: (d: Record<string, unknown>) => Date;
  xScale: (date: Date) => number | undefined;
}): AxisTick[] {
  const seenLabels = new Set<string>();
  const ticks: AxisTick[] = [];
  data.forEach((row, index) => {
    if (!keep(row, index)) {
      return;
    }
    const date = xAccessor(row);
    const label = dateLabels[index] ?? shortDateFmt.format(date);
    if (seenLabels.has(label)) {
      return;
    }
    seenLabels.add(label);
    ticks.push({ date, label, x: (xScale(date) ?? 0) + marginLeft });
  });
  return ticks;
}

function domainExtendsPastData(
  data: Record<string, unknown>[],
  xAccessor: (d: Record<string, unknown>) => Date,
  xScale: { domain: () => Date[] },
): boolean {
  if (data.length === 0) {
    return false;
  }
  const domainEnd = xScale.domain()[1];
  const lastPoint = data.at(-1);
  if (!(domainEnd && lastPoint)) {
    return false;
  }
  return domainEnd.getTime() > xAccessor(lastPoint).getTime();
}

/** Domain ticks for the projection tail when brush keeps data-aligned labels. */
function appendProjectionTailTicks(
  ticks: AxisTick[],
  data: Record<string, unknown>[],
  xAccessor: (d: Record<string, unknown>) => Date,
  xScale: {
    domain: () => Date[];
    (date: Date): number | undefined;
  },
  marginLeft: number,
  maxExtraTicks: number,
): AxisTick[] {
  if (data.length === 0 || maxExtraTicks <= 0) {
    return ticks;
  }

  const lastPoint = data.at(-1);
  const domainEnd = xScale.domain()[1];
  if (!(lastPoint && domainEnd)) {
    return ticks;
  }

  const lastDate = xAccessor(lastPoint);
  const startTime = lastDate.getTime();
  const endTime = domainEnd.getTime();
  if (endTime <= startTime) {
    return ticks;
  }

  const seenLabels = new Set(ticks.map((tick) => tick.label));
  const extras: AxisTick[] = [];
  const extraCount = Math.min(maxExtraTicks, 3);

  for (let i = 1; i <= extraCount; i++) {
    const date = new Date(startTime + (i / (extraCount + 1)) * (endTime - startTime));
    const label = shortDateFmt.format(date);
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    extras.push({
      date,
      label,
      x: (xScale(date) ?? 0) + marginLeft,
    });
  }

  const endLabel = shortDateFmt.format(domainEnd);
  if (!seenLabels.has(endLabel)) {
    extras.push({
      date: domainEnd,
      label: endLabel,
      x: (xScale(domainEnd) ?? 0) + marginLeft,
    });
  }

  if (extras.length === 0) {
    return ticks;
  }

  return [...ticks, ...extras].sort((a, b) => a.x - b.x);
}

export function XAxis(props: XAxisProps) {
  const { containerRef } = useChartStable();

  const container = useChartPortalContainer(containerRef);
  if (!container) {
    return null;
  }

  return <XAxisInner {...props} container={container} />;
}

const XAxisInner = memo(function XAxisInner({
  numTicks = 5,
  tickerHalfWidth = 40,
  tickMode = "data",
  labels: labelsProp,
  tickValues: tickValuesProp,
  tickFilter,
  formatTick,
  clamp = "container",
  container,
}: XAxisProps & { container: HTMLDivElement }) {
  const {
    xScale,
    margin,
    data,
    xAccessor,
    dateLabels: contextDateLabels,
    xDomain,
    width,
    innerWidth,
  } = useChartStable();
  const tooltipData = useChartHoverSelector(selectTooltipData);
  const dateLabels = useMemo(
    () =>
      formatTick
        ? data.map((row) => formatTick(xAccessor(row)))
        : (labelsProp ?? contextDateLabels),
    [formatTick, data, xAccessor, labelsProp, contextDateLabels],
  );
  const resolvedNumTicks = useMemo(
    () => resolveResponsiveChartLabelCount(numTicks, width, 5),
    [numTicks, width],
  );
  // Keyed on the times, so an inline `tickValues={[…]}` array stays cheap.
  const tickValuesKey = tickValuesProp?.map((date) => date.getTime()).join(",");
  const tickValues = useMemo(
    () =>
      tickValuesKey === undefined
        ? undefined
        : tickValuesKey
            .split(",")
            .filter(Boolean)
            .map((time) => new Date(Number(time))),
    [tickValuesKey],
  );

  const labelsToShow = useMemo(() => {
    const format = formatTick ?? ((date: Date) => shortDateFmt.format(date));

    if (tickValues) {
      return buildValueTicks({
        format,
        marginLeft: margin.left,
        tickValues,
        xScale,
      });
    }

    const projectionExtendsScale =
      tickMode === "data" && domainExtendsPastData(data, xAccessor, xScale);

    if (tickMode === "domain") {
      return buildDomainTicks({
        format,
        marginLeft: margin.left,
        numTicks: resolvedNumTicks,
        xScale,
      });
    }

    if (tickFilter) {
      return buildFilteredTicks({
        data,
        dateLabels,
        keep: tickFilter,
        marginLeft: margin.left,
        xAccessor,
        xScale,
      });
    }

    // No brush: evenly spaced ticks across the full domain (data + projection).
    if (projectionExtendsScale && xDomain == null) {
      return buildDomainTicks({
        format,
        marginLeft: margin.left,
        numTicks: resolvedNumTicks,
        xScale,
      });
    }

    const dataTicks = buildDataAlignedTicks({
      data,
      dateLabels,
      marginLeft: margin.left,
      targetTickCount: resolvedNumTicks,
      xAccessor,
      xScale,
    });

    // Brush: keep data-aligned ticks, add labels only in the projection tail.
    if (projectionExtendsScale && xDomain != null) {
      return appendProjectionTailTicks(
        dataTicks,
        data,
        xAccessor,
        xScale,
        margin.left,
        Math.max(1, resolvedNumTicks - dataTicks.length + 1),
      );
    }

    return dataTicks;
  }, [
    tickValues,
    tickFilter,
    formatTick,
    tickMode,
    xDomain,
    data,
    dateLabels,
    xAccessor,
    xScale,
    margin.left,
    resolvedNumTicks,
  ]);

  const bounds = useMemo<readonly [number, number] | null>(() => {
    if (clamp === "none") {
      return null;
    }
    return clamp === "plot" ? [margin.left, margin.left + innerWidth] : [0, width];
  }, [clamp, margin.left, innerWidth, width]);

  const crosshairX = tooltipData ? tooltipData.x + margin.left : null;
  const hoveredLabel = tooltipData
    ? (dateLabels[tooltipData.index] ?? shortDateFmt.format(xAccessor(tooltipData.point)))
    : null;

  return createPortal(
    <div className="pointer-events-none absolute inset-0">
      {labelsToShow.map((item) => (
        <XAxisLabel
          animatePosition={xDomain == null}
          bounds={bounds}
          key={`${item.date.getTime()}-${item.x}`}
          label={item.label}
          opacity={xAxisLabelOpacity(item.label, item.x, crosshairX, hoveredLabel, tickerHalfWidth)}
          x={item.x}
        />
      ))}
    </div>,
    container,
  );
});

XAxis.displayName = "XAxis";

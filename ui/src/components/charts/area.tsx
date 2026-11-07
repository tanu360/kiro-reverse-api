"use client";

import { type CurveFactory, curveMonotoneX } from "d3-shape";

import { useCallback, useId, useMemo, useRef } from "react";
import { AreaGradientDefs } from "./area-gradient-defs";
import { chartCssVars, useChartStable, useYScale } from "./chart-context";
import type { ChartPhase, LoadingStyle } from "./chart-phase";
import { type FadeEdges, resolveFadeSides } from "./fade-edges";
import {
  type LineLoadingPulseMode,
  LineLoadingPulseStroke,
  resolveLineLoadingPulseMode,
} from "./line-loading-pulse";
import { areaClosedD, LinePath, linePathD } from "./line-path";
import { LineLoadingSweep } from "./loading-sweep";
import { resolveDashTailBounds, usePathStrokeMetrics } from "./path-stroke-utils";
import { SeriesDashTailOverlay } from "./series-dash-tail-overlay";
import { SeriesHighlightLayer } from "./series-highlight-layer";
import { SeriesHoverDim } from "./series-hover-dim";
import { SeriesMarkers } from "./series-markers";
import type { SeriesPointMarkerStyle } from "./series-point-marker";

/**
 * Series look:
 * - `"area"` (default): stroke over a gradient fill.
 * - `"muted"`: a quiet muted-foreground line (30%), no fill and no hover
 *   highlight, for empty states.
 * - `"line-dash"`: a dashed `var(--chart-comparison)` line ("4 4"), no fill and
 *   no hover highlight, for a previous-period comparison series.
 *
 * Explicit `stroke`, `strokeWidth` and `dashArray` still win.
 */
export type AreaVariant = "area" | "muted" | "line-dash";

export interface AreaProps {
  /** Key in data to use for y values */
  dataKey: string;
  /** Series look. Default: `"area"`. */
  variant?: AreaVariant;
  /** Y-scale group id (Recharts `yAxisId`). Default: `"left"`. */
  yAxisId?: string | number;
  /** Fill color for the area gradient start. Default: var(--chart-line-primary) */
  fill?: string;
  /** Fill opacity at the top of the area. Default: 0.4 */
  fillOpacity?: number;
  /** Stroke color for the line. Default: same as fill */
  stroke?: string;
  /** Stroke width. Default: 2 */
  strokeWidth?: number;
  /** Curve function. Default: curveMonotoneX */
  curve?: CurveFactory;
  /** Whether to animate the area. Default: true */
  animate?: boolean;
  /** Whether to show the stroke line. Default: true */
  showLine?: boolean;
  /** Whether to show highlight segment on hover. Default: true */
  showHighlight?: boolean;
  /** Gradient opacity at bottom (0 = fully transparent). Default: 0 */
  gradientToOpacity?: number;
  /**
   * Vertical extent of the fill gradient (0–1). `1` fades across the full
   * height; lower values compress the gradient toward the top.
   */
  gradientSpan?: number;
  /**
   * Fade the area fill (and stroke) toward transparent at the chart edges.
   * - `true` fades both edges, `false` disables the fade entirely.
   * - `"left"` / `"right"` fades only that side — useful when the opposite
   *   edge butts up against another element you don't want to fade into.
   * Default: false
   */
  fadeEdges?: FadeEdges;
  /** Render scatter-style circle markers at each data point. Default: false */
  showMarkers?: boolean;
  /** Marker styling (same options as Scatter). */
  markers?: SeriesPointMarkerStyle;
  /** Show smart formatted values above data points. Default: false. */
  showValue?: boolean;
  /** Preferred minimum labels per series, subject to available space. Default: 2. */
  valueLabelMinCount?: number;
  /** Maximum labels per series. Zero hides labels; omitted uses available width. */
  valueLabelMaxCount?: number;
  /** Format values displayed above data points. */
  valueLabelFormatter?: (value: number) => string;
  /** Text color for values displayed above data points. Default: same as stroke. */
  valueLabelColor?: string;
  /** Fade value labels with the chart edges. Default: false. */
  fadeValueLabels?: boolean;
  /**
   * Data index from which the line stroke becomes dashed (inclusive).
   * Useful for projecting incomplete periods, e.g. dashed from yesterday through today.
   */
  dashFromIndex?: number;
  /** Dash pattern for the tail segment when `dashFromIndex` is set. Default: "6,4" */
  dashArray?: string;
  /** Pulse stroke color while chart is loading. Default: var(--foreground) */
  loadingStroke?: string;
  /** Pulse stroke opacity while chart is loading. Default: 0.5 */
  loadingStrokeOpacity?: number;
  /**
   * Show the loading pulse overlay. Default: follows chart loading phase.
   * Set `false` to disable even during loading.
   */
  loading?: boolean;
  /** Override pulse animation mode (loop / exit / enter). */
  loadingPulseMode?: LineLoadingPulseMode;
  /**
   * Loading animation while the chart is in loading status: the default
   * traveling `"pulse"`, or a diagonal `"sweep"` shimmer across the skeleton
   * area. Default: `"pulse"`.
   */
  loadingStyle?: LoadingStyle;
}

const MUTED_SERIES_STROKE = "color-mix(in oklab, var(--muted-foreground) 30%, transparent)";
const COMPARISON_SERIES_STROKE = "var(--chart-comparison)";
const COMPARISON_SERIES_DASH = "4 4";
const QUIET_SERIES_STROKE_WIDTH = 1.5;

/**
 * Props with the variant's defaults applied: the chart reads the same result
 * for its series config (tooltip dots, value labels) as the series draws.
 */
export function resolveAreaVariant(props: AreaProps): AreaProps {
  const { variant = "area" } = props;
  if (variant === "area") {
    return props;
  }
  const stroke =
    props.stroke ?? (variant === "muted" ? MUTED_SERIES_STROKE : COMPARISON_SERIES_STROKE);
  return {
    ...props,
    stroke,
    fill: stroke,
    fillOpacity: 0,
    strokeWidth: props.strokeWidth ?? QUIET_SERIES_STROKE_WIDTH,
    showHighlight: false,
    showMarkers: false,
    // The dash-tail stroke from the first point: the whole line is dashed.
    ...(variant === "line-dash"
      ? {
          dashFromIndex: 0,
          dashArray: props.dashArray ?? COMPARISON_SERIES_DASH,
        }
      : {}),
  };
}

function useAreaLoadingPulseState(
  chartPhase: ChartPhase,
  loading: boolean | undefined,
  loadingPulseMode: LineLoadingPulseMode | undefined,
  notifyLoadingPulseComplete?: () => void,
) {
  const phasePulseMode = resolveLineLoadingPulseMode(chartPhase);
  const pulseMode =
    loading === false ? null : (loadingPulseMode ?? (loading === true ? "loop" : phasePulseMode));
  const showLoadingPulse = pulseMode != null;
  const showSeriesContent =
    chartPhase === "revealing" || chartPhase === "ready" || chartPhase === "exitingReady";
  // The pulse loops on its own; only the exit / enter hand-off is reported.
  const handleLoadingPulseComplete = useCallback(() => {
    if (pulseMode === "loop") {
      return;
    }
    notifyLoadingPulseComplete?.();
  }, [notifyLoadingPulseComplete, pulseMode]);

  return {
    handleLoadingPulseComplete,
    pulseMode,
    showLoadingPulse,
    showSeriesContent,
  };
}

/** One series of an `AreaChart`: a filled area, or a quiet / dashed line (see `variant`). */
export function Area(props: AreaProps) {
  return <AreaSeries {...resolveAreaVariant(props)} />;
}

function AreaSeries({
  dataKey,
  yAxisId,
  fill = chartCssVars.linePrimary,
  fillOpacity = 0.4,
  stroke,
  strokeWidth = 2,
  curve = curveMonotoneX,
  animate = true,
  showLine = true,
  showHighlight = true,
  gradientToOpacity = 0,
  gradientSpan = 1,
  fadeEdges = false,
  showMarkers = false,
  markers,
  dashFromIndex,
  dashArray = "6,4",
  loading,
  loadingStroke = chartCssVars.foreground,
  loadingStrokeOpacity = 0.5,
  loadingPulseMode,
  loadingStyle = "pulse",
}: AreaProps) {
  // Stable slice only: hover state lives inside `<SeriesHoverDim>` and
  // `<SeriesHighlightLayer>` so this component (and its expensive
  // <SeriesDashTailOverlay> child) does not re-render on cursor motion.
  // The reveal-clip is now a single shared clipPath at the chart-shell
  // level (`time-series-chart-shell.tsx`); we no longer render a per-area
  // `<ChartRevealClip>` or read `revealEpoch` here.
  const {
    data,
    renderData,
    xScale,
    innerHeight,
    innerWidth,
    xAccessor,
    lines,
    chartPhase,
    notifyLoadingPulseComplete,
  } = useChartStable();
  const yScale = useYScale(yAxisId);
  const seriesIndex = useMemo(() => {
    const index = lines.findIndex((line) => line.dataKey === dataKey);
    return Math.max(index, 0);
  }, [lines, dataKey]);
  // The loading skeleton only carries the first series' values, so only that
  // series pulses; the others would trace the plot's top edge. They appear on reveal.
  const { handleLoadingPulseComplete, pulseMode, showLoadingPulse, showSeriesContent } =
    useAreaLoadingPulseState(
      chartPhase,
      loading ?? (seriesIndex === 0 ? undefined : false),
      loadingPulseMode,
      notifyLoadingPulseComplete,
    );

  const pathRef = useRef<SVGPathElement>(null);
  const hasDashTail = resolveDashTailBounds(dashFromIndex, data.length);
  const { pathLength, pathD } = usePathStrokeMetrics(
    pathRef,
    [renderData, innerWidth, dashFromIndex, showLine, showSeriesContent, showLoadingPulse],
    // Only the dash tail and loading pulse read the metrics; outside the
    // resting "ready" phase keep measuring so a pulse starts on a fresh path.
    hasDashTail || showLoadingPulse || chartPhase !== "ready",
  );

  // Unique IDs for this area
  const uniqueId = useId();
  const gradientId = `area-gradient-${dataKey}-${uniqueId}`;
  const strokeGradientId = `area-stroke-gradient-${dataKey}-${uniqueId}`;
  const edgeMaskId = `area-edge-mask-${dataKey}-${uniqueId}`;
  const edgeGradientId = `${edgeMaskId}-gradient`;

  const isPatternFill = fill.startsWith("url(");
  const showAreaFill = isPatternFill || fillOpacity > 0;
  const areaFill = isPatternFill ? fill : `url(#${gradientId})`;

  // Resolved stroke color (defaults to fill; pattern URLs need a real color)
  const resolvedStroke = stroke || (isPatternFill ? chartCssVars.linePrimary : fill);

  const getY = useCallback(
    (d: Record<string, unknown>) => {
      const value = d[dataKey];
      return typeof value === "number" ? (yScale(value) ?? 0) : 0;
    },
    [dataKey, yScale],
  );

  // The stroke gradient is only emitted when at least one edge fades, so fall
  // back to the resolved solid color otherwise — avoids an invalid url(#...).
  const fadeSides = resolveFadeSides(fadeEdges);
  const useViewportEdgeFade = fadeSides.any && !isPatternFill;
  let strokePaint = resolvedStroke;
  if (!useViewportEdgeFade && fadeSides.any) {
    strokePaint = `url(#${strokeGradientId})`;
  }
  const highlightEnabled = showHighlight && showLine && !showLoadingPulse && showSeriesContent;
  const showSeriesStroke = showSeriesContent && showLine;
  let visibleStroke = "transparent";
  if (showSeriesStroke && !hasDashTail) {
    visibleStroke = strokePaint;
  }
  const shouldMeasurePath = showLine && (showSeriesContent || showLoadingPulse);
  const showFill = showSeriesContent && showAreaFill;

  // Fill and stroke `d` only change with their inputs, so re-renders for
  // other reasons reuse them. Hidden layers skip the work, as before.
  const getX = useCallback(
    (d: Record<string, unknown>) => xScale(xAccessor(d)) ?? 0,
    [xAccessor, xScale],
  );
  const areaPathD = useMemo(
    () => (showFill ? areaClosedD(renderData, { curve, x: getX, y: getY, yScale }) : ""),
    [curve, getX, getY, renderData, showFill, yScale],
  );
  const strokePathD = useMemo(
    () => (shouldMeasurePath ? linePathD(renderData, { curve, x: getX, y: getY }) : ""),
    [curve, getX, getY, renderData, shouldMeasurePath],
  );

  const seriesLayers = (
    <>
      {showFill ? <path d={areaPathD} fill={areaFill} /> : null}

      {shouldMeasurePath ? (
        <>
          <LinePath
            d={strokePathD}
            innerRef={pathRef}
            stroke={visibleStroke}
            strokeLinecap="round"
            strokeWidth={strokeWidth}
          />
          {showSeriesStroke && hasDashTail ? (
            <SeriesDashTailOverlay
              dashArray={dashArray}
              dashFromIndex={dashFromIndex}
              data={data}
              innerHeight={innerHeight}
              innerWidth={innerWidth}
              pathD={pathD}
              pathLength={pathLength}
              stroke={strokePaint}
              strokeWidth={strokeWidth}
              xAccessor={xAccessor}
              xScale={xScale}
            />
          ) : null}
        </>
      ) : null}
    </>
  );

  // Sweep style owns all loading modes (loop + the exit/enter transitions),
  // drawing its own silhouette; the pulse covers the default style.
  const sweepLoading = showLoadingPulse && innerWidth > 0 && loadingStyle === "sweep";
  const pulseLoading = showLoadingPulse && innerWidth > 0 && !sweepLoading;

  return (
    <>
      <AreaGradientDefs
        edgeGradientId={edgeGradientId}
        edgeMaskId={edgeMaskId}
        fadeEdges={fadeEdges}
        fill={fill}
        fillOpacity={fillOpacity}
        gradientId={gradientId}
        gradientSpan={gradientSpan}
        gradientToOpacity={gradientToOpacity}
        innerHeight={innerHeight}
        innerWidth={innerWidth}
        isPatternFill={isPatternFill}
        resolvedStroke={resolvedStroke}
        strokeGradientId={strokeGradientId}
      />

      <SeriesHoverDim dimOpacity={0.6} enabled={showHighlight} seriesIndex={seriesIndex}>
        {useViewportEdgeFade ? <g mask={`url(#${edgeMaskId})`}>{seriesLayers}</g> : seriesLayers}
      </SeriesHoverDim>

      {/* Highlight segment on hover — isolated hover subscriber. */}
      <SeriesHighlightLayer
        enabled={highlightEnabled}
        height={innerHeight}
        pathRef={pathRef}
        stroke={resolvedStroke}
        strokeWidth={strokeWidth}
      />

      {showMarkers && showSeriesContent ? (
        <SeriesMarkers
          animate={animate}
          dataKey={dataKey}
          {...markers}
          fill={markers?.fill ?? resolvedStroke}
          stroke={markers?.stroke ?? markers?.fill ?? resolvedStroke}
        />
      ) : null}

      {sweepLoading ? (
        <LineLoadingSweep
          curve={curve}
          key="loading-sweep"
          mode={pulseMode ?? "loop"}
          onTransitionComplete={handleLoadingPulseComplete}
          stroke={loadingStroke}
          strokeOpacity={loadingStrokeOpacity}
          strokeWidth={strokeWidth}
          withArea
        />
      ) : null}
      {pulseLoading && pathD ? (
        <LineLoadingPulseStroke
          key="loading-pulse"
          mode={pulseMode ?? undefined}
          onCycleComplete={handleLoadingPulseComplete}
          pathD={pathD}
          stroke={loadingStroke}
          strokeOpacity={loadingStrokeOpacity}
          strokeWidth={strokeWidth}
        />
      ) : null}
    </>
  );
}

Area.displayName = "Area";
AreaSeries.displayName = "AreaSeries";

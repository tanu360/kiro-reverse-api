import { curveMonotoneX, line } from "d3-shape";
import { type JSX, useId, useMemo } from "react";
import { dateLabelCount, rightAxisMargin } from "@/components/charts/axis-fit";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { useChartStable } from "@/components/charts/chart-context";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { YAxis } from "@/components/charts/y-axis";
import { useIsMobile } from "@/hooks/use-media-query";
import { formatNumber, formatTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { bucketLabel, bucketTitle, type TimeBucket } from "@/lib/time-buckets";
import type { TrafficPoint } from "./aggregate";
import {
  FAILED_COLOR,
  PREVIOUS_COLOR,
  RETRIED_COLOR,
  SUCCEEDED_COLOR,
  TRACK_COLOR,
} from "./colors";
import { PLOT_HEIGHT } from "./traffic-card";

// The count labels sit in the right margin (mono chart ticks). The 8 px on the left keeps the
// first time label, centred on the first bar, inside a phone card's padding.
const MARGIN = { top: 8, right: 36, bottom: 28, left: 8 };
/** The minute views' x-axis labels: short clock times. */
const TIME_LABELS = { base: 3, sm: 4, md: 6 };

export interface TrafficChartLabels {
  succeeded: string;
  retried: string;
  failed: string;
  previous: string;
  /** "2 min": the bucket size after the time range in the tooltip title. */
  bucket: string;
}

/** A traffic bucket plus its retried attempts (the proxy counts those apart from requests). */
export interface TrafficBar extends TrafficPoint {
  retried: number;
}

/** All time's calendar bars: dates on the axis and a period title instead of clock times. */
export interface TrafficPeriod {
  bucket: TimeBucket;
  bucketSeconds: number;
  /** Minutes east of UTC the server bucketed with. */
  tzOffset: number;
}

/**
 * Diagonal hatching in one series colour: a 30 % wash with a solid 3 px stripe every 6 px. The
 * name must contain "Pattern" (and survive minifying): BarChart lays such children out first,
 * where the bars' `url(#id)` fills can reach them.
 */
function HatchPattern({ id, color }: { id: string; color: string }): JSX.Element {
  return (
    <pattern
      height={6}
      id={id}
      patternTransform="rotate(45)"
      patternUnits="userSpaceOnUse"
      width={6}
    >
      <rect fill={color} fillOpacity={0.3} height={6} width={6} />
      <rect fill={color} height={6} width={3} />
    </pattern>
  );
}
HatchPattern.displayName = "HatchPattern";

/**
 * The empty column behind every bar, full plot height, so a quiet bucket still reads as a slot
 * on the time axis. BarChart draws a "BarColumnTrack" under the series.
 */
function BarColumnTrack(): JSX.Element | null {
  const { data, barScale, bandWidth, barXAccessor, innerHeight } = useChartStable();
  if (!barScale || !barXAccessor || !bandWidth) return null;
  const radius = Math.min(3, bandWidth / 2);
  return (
    <g>
      {data.map((datum) => {
        const key = barXAccessor(datum);
        return (
          <rect
            fill={TRACK_COLOR}
            fillOpacity={0.55}
            height={innerHeight}
            key={key}
            rx={radius}
            width={bandWidth}
            x={barScale(key) ?? 0}
            y={0}
          />
        );
      })}
    </g>
  );
}
BarColumnTrack.displayName = "BarColumnTrack";

/**
 * The previous hour as a dashed curve through the bar centres. BarChart draws a "TrendLine" above
 * every bar.
 */
function TrendLine({ dataKey }: { dataKey: string }): JSX.Element | null {
  const { data, barScale, bandWidth, barXAccessor, yScale } = useChartStable();
  const path = useMemo(() => {
    if (!barScale || !barXAccessor || !bandWidth) return null;
    const centre = (datum: Record<string, unknown>) =>
      (barScale(barXAccessor(datum)) ?? 0) + bandWidth / 2;
    return line<Record<string, unknown>>()
      .curve(curveMonotoneX)
      .x(centre)
      .y((datum) => yScale(Number(datum[dataKey] ?? 0)) ?? 0)(data);
  }, [data, barScale, bandWidth, barXAccessor, yScale, dataKey]);
  if (!path) return null;
  return (
    <path
      d={path}
      fill="none"
      stroke={PREVIOUS_COLOR}
      strokeDasharray="4 4"
      strokeLinecap="round"
      strokeWidth={1.5}
    />
  );
}
TrendLine.displayName = "TrendLine";

/**
 * Lazy-loaded Bklit bar chart for the traffic card: one stacked bar per bucket, succeeded,
 * retried and failed in hatched purple, amber and red over a faint full-height track, and (1 h)
 * the previous hour as a dashed grey curve. In the loading state BarChart draws its own
 * skeleton; with no traffic only the tracks remain.
 */
export default function TrafficChart({
  bars,
  bucketMin,
  period,
  lang,
  labels,
  reducedMotion,
  status = "ready",
  empty = false,
}: {
  bars: TrafficBar[];
  bucketMin: number;
  /** All time: bars of a day or more, labelled by date. */
  period?: TrafficPeriod;
  lang: Lang;
  labels: TrafficChartLabels;
  reducedMotion: boolean;
  status?: "loading" | "ready";
  empty?: boolean;
}): JSX.Element {
  const phone = useIsMobile();
  const id = useId().replace(/:/g, "");
  const ids = { succeeded: `ok-${id}`, retried: `rt-${id}`, failed: `bad-${id}` };
  const hasPrevious = bars.some((bar) => bar.previous !== undefined);
  const data = useMemo(
    () =>
      bars.map((bar) => {
        const start = bar.date.getTime() / 1000;
        const stacked = bar.succeeded + bar.retried + bar.failed;
        return {
          name: period
            ? bucketLabel(start, period.bucket, period.tzOffset, lang)
            : formatTime(start, lang),
          start,
          succeeded: bar.succeeded,
          retried: bar.retried,
          failed: bar.failed,
          ...(bar.previous === undefined
            ? {}
            : {
                previous: bar.previous,
                // An invisible cap above the stack, so the y-scale reaches the dashed line too.
                headroom: Math.max(0, bar.previous - stacked),
              }),
        };
      }),
    [bars, lang, period],
  );
  // All time: counts past 1,000 can spell long ("1 mil"), and so can dates ("29 de set."); the
  // minute views keep their fixed margin and labels.
  const margin = useMemo(
    () =>
      period
        ? {
            ...MARGIN,
            right: rightAxisMargin(
              Math.max(0, ...bars.map((bar) => bar.succeeded + bar.retried + bar.failed)),
              MARGIN.right,
              lang,
            ),
          }
        : MARGIN,
    [bars, period, lang],
  );
  const maxLabels = useMemo(
    () => (period ? dateLabelCount(data.map((datum) => datum.name)) : TIME_LABELS),
    [data, period],
  );

  return (
    <BarChart
      animationDuration={reducedMotion ? 0 : undefined}
      aspectRatio="auto"
      // Narrower gaps on a phone, so its fewer bars read as bars, not hairlines.
      barGap={phone ? 0.22 : 0.35}
      className={PLOT_HEIGHT}
      data={data}
      margin={margin}
      stacked
      stackGap={1}
      status={status}
      xDataKey="name"
    >
      <HatchPattern color={SUCCEEDED_COLOR} id={ids.succeeded} />
      <HatchPattern color={RETRIED_COLOR} id={ids.retried} />
      <HatchPattern color={FAILED_COLOR} id={ids.failed} />
      {/*
        An empty chart keeps only its time axis: no columns (their stripes ran through the "No
        traffic" notice), no count scale over nothing and no flat previous-hour line.
      */}
      {empty ? null : <BarColumnTrack />}
      {empty ? null : <YAxis numTicks={4} side="right" />}
      <Bar
        animate={!reducedMotion}
        dataKey="succeeded"
        fill={`url(#${ids.succeeded})`}
        lineCap={2}
        stroke={SUCCEEDED_COLOR}
      />
      <Bar
        animate={!reducedMotion}
        dataKey="retried"
        fill={`url(#${ids.retried})`}
        lineCap={2}
        stroke={RETRIED_COLOR}
      />
      <Bar
        animate={!reducedMotion}
        dataKey="failed"
        fill={`url(#${ids.failed})`}
        lineCap={2}
        stroke={FAILED_COLOR}
      />
      {hasPrevious ? <Bar animate={false} dataKey="headroom" fill="transparent" /> : null}
      {hasPrevious && !empty ? <TrendLine dataKey="previous" /> : null}
      <BarXAxis maxLabels={maxLabels} />
      {/* An empty chart has nothing to inspect: no tooltip over its empty state. */}
      {empty ? null : (
        <ChartTooltip
          content={({ point }) => {
            const start = Number(point.start);
            const rows: TooltipRow[] = [
              {
                color: SUCCEEDED_COLOR,
                label: labels.succeeded,
                value: formatNumber(Number(point.succeeded), lang),
              },
              {
                color: RETRIED_COLOR,
                label: labels.retried,
                value: formatNumber(Number(point.retried), lang),
              },
              {
                color: FAILED_COLOR,
                label: labels.failed,
                value: formatNumber(Number(point.failed), lang),
              },
            ];
            if (hasPrevious) {
              rows.push({
                color: PREVIOUS_COLOR,
                label: labels.previous,
                value: formatNumber(Number(point.previous ?? 0), lang),
              });
            }
            return (
              <TooltipContent
                meta={period ? undefined : labels.bucket}
                mono
                rows={rows}
                title={
                  period
                    ? bucketTitle(start, period.bucket, period.bucketSeconds, period.tzOffset, lang)
                    : `${formatTime(start, lang)}–${formatTime(start + bucketMin * 60, lang)}`
                }
              />
            );
          }}
          showCrosshair={false}
          showDatePill={false}
          showDots={false}
        />
      )}
    </BarChart>
  );
}

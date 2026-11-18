import { curveMonotoneX, line } from "d3-shape";
import { type JSX, useId, useMemo } from "react";
import { dateLabelCount, rightAxisMargin } from "@/components/charts/axis-fit";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { useChartStable, useSettledYScale } from "@/components/charts/chart-context";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { YAxis } from "@/components/charts/y-axis";
import { useIsMobile } from "@/hooks/use-media-query";
import { formatNumber, formatTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { bucketLabel, bucketTitle, type TimeBucket } from "@/lib/time-buckets";
import type { TrafficPoint } from "./aggregate";
import { PREVIOUS_COLOR, TRACK_COLOR } from "./colors";
import { PLOT_HEIGHT } from "./traffic-card";

// The count labels sit in the right margin (mono chart ticks). The 8 px on the left keeps the
// first time label, centred on the first bar, inside a phone card's padding.
const MARGIN = { top: 8, right: 36, bottom: 28, left: 8 };
/** The minute views' x-axis labels: short clock times. */
const TIME_LABELS = { base: 3, sm: 4, md: 6 };

/** One stacked series, bottom first: its name in the tooltip and its colour. */
export interface TrafficSeries {
  label: string;
  color: string;
}

/** A traffic bucket plus its retried attempts (the proxy counts those apart from requests). */
export interface TrafficBar extends TrafficPoint {
  retried: number;
}

/**
 * One bar as the chart draws it: its start, its parts in the order of the series (bottom first)
 * and, in the 1 h view, the previous hour's count for the dashed curve.
 */
export interface StackedBar {
  date: Date;
  parts: readonly number[];
  previous?: number;
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

/** Count labels in whole numbers: two requests read 0, 1, 2, not 0, 0.5 … 2. */
function WholeNumberYAxis(): JSX.Element {
  const scale = useSettledYScale();
  const ticks = scale.ticks(4).filter((tick) => Number.isInteger(tick));
  return <YAxis numTicks={4} side="right" tickValues={ticks} />;
}
// Named as the axis it wraps, so the chart keeps it out of the series' reveal clip like YAxis.
WholeNumberYAxis.displayName = "YAxis";

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

/** The data key of the series at `index` in the chart's rows. */
const partKey = (index: number) => `part${index}`;

/**
 * Lazy-loaded Bklit bar chart for the traffic card: one stacked bar per bucket, each series
 * hatched in its colour over a faint full-height track (the Overview: succeeded, retried and
 * failed in purple, amber and red), and (1 h) the previous hour as a dashed grey curve. In the
 * loading state BarChart draws its own skeleton; with no traffic only the tracks remain. The API
 * key usage cards draw a key's requests, tokens or credits with it.
 */
export default function TrafficChart({
  bars,
  series,
  bucketMin,
  period,
  lang,
  previousLabel = "",
  bucketSize,
  formatValue,
  wholeNumbers = false,
  reducedMotion,
  status = "ready",
  empty = false,
}: {
  bars: StackedBar[];
  /** The stacked series, bottom first, in the order of each bar's parts. */
  series: readonly TrafficSeries[];
  bucketMin: number;
  /** Bars of an hour or more, labelled by the server's bucket (All time, a key's usage). */
  period?: TrafficPeriod;
  lang: Lang;
  /** The dashed series' name in the tooltip, for bars that carry `previous`. */
  previousLabel?: string;
  /** "2 min": the bucket size after the time range in the tooltip title, without a period. */
  bucketSize?: string;
  /** The tooltip's values; whole numbers in the UI language by default. */
  formatValue?: (value: number) => string;
  /** Counts that can be small: the axis skips fractional labels. */
  wholeNumbers?: boolean;
  reducedMotion: boolean;
  status?: "loading" | "ready";
  empty?: boolean;
}): JSX.Element {
  const phone = useIsMobile();
  const id = useId().replace(/:/g, "");
  const hasPrevious = bars.some((bar) => bar.previous !== undefined);
  const format = formatValue ?? ((value: number) => formatNumber(value, lang));
  // Only the count of series shapes the rows, so a new array of the same series keeps them.
  const partCount = series.length;
  const data = useMemo(
    () =>
      bars.map((bar) => {
        const start = bar.date.getTime() / 1000;
        const row: { name: string } & Record<string, string | number> = {
          name: period
            ? bucketLabel(start, period.bucket, period.tzOffset, lang)
            : formatTime(start, lang),
          start,
        };
        let stacked = 0;
        for (let index = 0; index < partCount; index++) {
          const value = bar.parts[index] ?? 0;
          row[partKey(index)] = value;
          stacked += value;
        }
        if (bar.previous !== undefined) {
          row.previous = bar.previous;
          // An invisible cap above the stack, so the y-scale reaches the dashed line too.
          row.headroom = Math.max(0, bar.previous - stacked);
        }
        return row;
      }),
    [bars, partCount, lang, period],
  );
  // All time: counts past 1,000 can spell long ("1 mil"), and so can dates ("29 de set."); the
  // minute views keep their fixed margin and labels.
  const margin = useMemo(
    () =>
      period
        ? {
            ...MARGIN,
            right: rightAxisMargin(
              Math.max(0, ...bars.map((bar) => bar.parts.reduce((sum, value) => sum + value, 0))),
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
      // BarChart keeps the series it first laid out: new colours (a key's usage card switching
      // from tokens to requests) draw on a fresh chart, or the old hatching stays.
      key={series.map((part) => part.color).join(" ")}
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
      {series.map((part, index) => (
        // Siblings of the Bars below, which take partKey: a key of its own, or React warns.
        <HatchPattern
          color={part.color}
          id={`${partKey(index)}-${id}`}
          key={`hatch-${partKey(index)}`}
        />
      ))}
      {/*
        An empty chart keeps only its time axis: no columns (their stripes ran through the "No
        traffic" notice), no count scale over nothing and no flat previous-hour line.
      */}
      {empty ? null : <BarColumnTrack />}
      {empty ? null : wholeNumbers ? <WholeNumberYAxis /> : <YAxis numTicks={4} side="right" />}
      {series.map((part, index) => (
        <Bar
          animate={!reducedMotion}
          dataKey={partKey(index)}
          fill={`url(#${partKey(index)}-${id})`}
          key={partKey(index)}
          lineCap={2}
          stroke={part.color}
        />
      ))}
      {hasPrevious ? <Bar animate={false} dataKey="headroom" fill="transparent" /> : null}
      {hasPrevious && !empty ? <TrendLine dataKey="previous" /> : null}
      {/* No date pill (showDatePill={false} below), so nothing should clear room under the pointer. */}
      <BarXAxis maxLabels={maxLabels} tickerHalfWidth={0} />
      {/* An empty chart has nothing to inspect: no tooltip over its empty state. */}
      {empty ? null : (
        <ChartTooltip
          content={({ point }) => {
            const start = Number(point.start);
            const rows: TooltipRow[] = series.map((part, index) => ({
              color: part.color,
              label: part.label,
              value: format(Number(point[partKey(index)] ?? 0)),
            }));
            if (hasPrevious) {
              rows.push({
                color: PREVIOUS_COLOR,
                label: previousLabel,
                value: format(Number(point.previous ?? 0)),
              });
            }
            return (
              <TooltipContent
                meta={period ? undefined : bucketSize}
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

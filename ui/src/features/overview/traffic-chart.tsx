import { curveMonotoneX } from "d3-shape";
import { type JSX, useMemo, useRef } from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { roundTimeTicks, XAxis } from "@/components/charts/x-axis";
import { niceTicks, YAxis } from "@/components/charts/y-axis";
import { useElementWidth } from "@/hooks/use-element-width";
import { formatNumber, formatTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { peakCount, type TrafficPoint } from "./aggregate";
import { FAILED_COLOR, PREVIOUS_COLOR, SUCCEEDED_COLOR } from "./colors";
import { PLOT_HEIGHT } from "./traffic-card";

// The count labels sit in the right margin (mono chart ticks), so the plot starts at the card's
// left padding, in line with the title.
const MARGIN = { top: 8, right: 36, bottom: 28, left: 0 };

export interface TrafficChartLabels {
  succeeded: string;
  failed: string;
  previous: string;
  /** "2 min": the bucket size after the time range in the tooltip title. */
  bucket: string;
}

/** Round-time steps in minutes, finest first; each range starts at its own finest step. */
const TICK_STEPS = [15, 30, 60, 120, 180, 240, 360, 480, 720] as const;
/** Tick-to-tick distance a time label needs ("11:30 AM" is about 55 px) plus clear space. */
const MIN_TICK_GAP = 80;

/**
 * The x-axis step: the finest round time (from every 15 min for the 1 h view, every hour for
 * 6 h, every 4 h for 24 h) whose labels sit at least MIN_TICK_GAP apart across the plot, so a
 * phone gets every 30 min, 2 h or 8 h instead of labels running into each other.
 */
function tickStep(bucketMin: number, spanMin: number, plotWidth: number): number {
  const finest = bucketMin <= 2 ? 15 : bucketMin <= 5 ? 60 : 240;
  const steps = TICK_STEPS.filter((step) => step >= finest);
  if (!(plotWidth > 0 && spanMin > 0)) return finest;
  return (
    steps.find((step) => (plotWidth * step) / spanMin >= MIN_TICK_GAP) ?? steps.at(-1) ?? finest
  );
}

/**
 * Lazy-loaded Bklit area chart for the traffic card: succeeded as a purple line over a faint
 * gradient, failed as a red line, and (1 h) the previous hour as a dashed grey line. In the
 * loading state it draws its own shimmering grid; with no traffic the series go grey.
 */
export default function TrafficChart({
  points,
  bucketMin,
  lang,
  labels,
  reducedMotion,
  status = "ready",
  empty = false,
}: {
  points: TrafficPoint[];
  bucketMin: number;
  lang: Lang;
  labels: TrafficChartLabels;
  reducedMotion: boolean;
  status?: "loading" | "ready";
  empty?: boolean;
}): JSX.Element {
  const hasPrevious = points.some((p) => p.previous !== undefined);
  const data = useMemo(
    () =>
      points.map((p) => ({
        date: p.date,
        succeeded: p.succeeded,
        failed: p.failed,
        ...(p.previous === undefined ? {} : { previous: p.previous }),
      })),
    [points],
  );
  // Whole-number ticks whose top is the domain top, so the highest label sits on a gridline.
  const ticks = useMemo(() => niceTicks(peakCount(points), 4, { integer: true }), [points]);
  const top = ticks.at(-1) ?? 1;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const plotWidth = useElementWidth(boxRef) - MARGIN.left - MARGIN.right;
  const first = points.at(0)?.date;
  const last = points.at(-1)?.date;
  const span = first && last ? (last.getTime() - first.getTime()) / 60_000 : 0;
  const step = tickStep(bucketMin, span, plotWidth);
  // Ticks on the round times themselves (not the bucket holding them), so they space evenly.
  const timeTicks = useMemo(
    () => (first && last ? roundTimeTicks(first, last, step) : []),
    [first, last, step],
  );
  const timeLabels = useMemo(
    () => points.map((p) => formatTime(p.date.getTime() / 1000, lang)),
    [points, lang],
  );
  const quiet = empty ? "muted" : "area";

  return (
    <div ref={boxRef}>
      <AreaChart
        animationDuration={reducedMotion ? 0 : undefined}
        aspectRatio="auto"
        className={PLOT_HEIGHT}
        data={data}
        margin={MARGIN}
        status={status}
        yDomain={[0, top]}
      >
        <Grid horizontal rowTickValues={ticks} />
        <YAxis side="right" tickValues={ticks} />
        {/* Monotone curves never overshoot between buckets, so a 1 -> 0 step cannot dip
          below the zero baseline. Series order matches the header legend (hover links them). */}
        <Area
          animate={!reducedMotion}
          curve={curveMonotoneX}
          dataKey="succeeded"
          fill={SUCCEEDED_COLOR}
          fillOpacity={0.16}
          strokeWidth={1.5}
          variant={quiet}
        />
        <Area
          animate={!reducedMotion}
          curve={curveMonotoneX}
          dataKey="failed"
          fill={FAILED_COLOR}
          fillOpacity={0}
          strokeWidth={1.5}
          variant={quiet}
        />
        {hasPrevious ? (
          <Area
            animate={!reducedMotion}
            curve={curveMonotoneX}
            dataKey="previous"
            stroke={PREVIOUS_COLOR}
            variant="line-dash"
          />
        ) : null}
        {/* "plot" keeps the end labels inside the plot, clear of the y labels on the right. */}
        <XAxis
          clamp="plot"
          formatTick={(date) => formatTime(date.getTime() / 1000, lang)}
          tickValues={timeTicks}
        />
        {/* An empty chart has nothing to inspect: no crosshair or tooltip over its empty state. */}
        {empty ? null : (
          <ChartTooltip
            content={({ point }) => {
              const start = (point.date as Date).getTime() / 1000;
              const rows: TooltipRow[] = [
                {
                  color: SUCCEEDED_COLOR,
                  label: labels.succeeded,
                  value: formatNumber(Number(point.succeeded), lang),
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
                  meta={labels.bucket}
                  mono
                  rows={rows}
                  title={`${formatTime(start, lang)}–${formatTime(start + bucketMin * 60, lang)}`}
                />
              );
            }}
            dateLabels={timeLabels}
          />
        )}
      </AreaChart>
    </div>
  );
}

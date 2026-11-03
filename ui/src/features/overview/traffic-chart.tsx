import { curveMonotoneX } from "d3-shape";
import { type JSX, useMemo } from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { useChartStable, useYScale } from "@/components/charts/chart-context";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip, TooltipContent } from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import { formatCompact, formatDateTime, formatNumber, formatTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { countTicks, type TrafficPoint } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";

// The left margin leaves room for the y-axis count labels.
const MARGIN = { top: 16, right: 24, bottom: 36, left: 44 };

/** Count labels left of the plot, placed with the chart's own (tweened) y-scale. */
function TrafficYAxis({ ticks }: { ticks: readonly number[] }): JSX.Element {
  const { innerHeight } = useChartStable();
  const yScale = useYScale();
  return (
    <g data-slot="traffic-y-axis">
      {ticks.map((tick) => (
        <text
          className="fill-chart-label text-xs tabular-nums"
          dominantBaseline="middle"
          key={tick}
          textAnchor="end"
          x={-10}
          y={yScale(tick) ?? innerHeight}
        >
          {formatCompact(tick)}
        </text>
      ))}
    </g>
  );
}
// Grouped with the chart's axes, so it is drawn outside the series reveal clip.
TrafficYAxis.displayName = "YAxis";

/** Lazy-loaded Bklit area chart for the traffic card. */
export default function TrafficChart({
  points,
  lang,
  labels,
  reducedMotion,
}: {
  points: TrafficPoint[];
  lang: Lang;
  labels: { succeeded: string; failed: string };
  reducedMotion: boolean;
}): JSX.Element {
  const data = useMemo(
    () => points.map((p) => ({ date: p.date, succeeded: p.succeeded, failed: p.failed })),
    [points],
  );
  // The grid and the labels share whole-number ticks, so every gridline carries its count.
  const ticks = useMemo(() => countTicks(points), [points]);
  const timeLabels = useMemo(
    () => points.map((p) => formatTime(p.date.getTime() / 1000, lang)),
    [points, lang],
  );

  return (
    <AreaChart
      animationDuration={reducedMotion ? 0 : undefined}
      aspectRatio="auto"
      className="h-72 @2xl:h-80"
      data={data}
      margin={MARGIN}
    >
      <Grid horizontal rowTickValues={ticks} />
      <TrafficYAxis ticks={ticks} />
      {/* Monotone curves never overshoot between buckets, so a 1 -> 0 step cannot dip
          below the zero baseline; the y-domain is zero-anchored for non-negative counts. */}
      <Area
        animate={!reducedMotion}
        curve={curveMonotoneX}
        dataKey="succeeded"
        fill={SUCCEEDED_COLOR}
        fillOpacity={0.3}
        strokeWidth={2}
      />
      <Area
        animate={!reducedMotion}
        curve={curveMonotoneX}
        dataKey="failed"
        fill={FAILED_COLOR}
        fillOpacity={0.3}
        strokeWidth={2}
      />
      <XAxis labels={timeLabels} numTicks={5} />
      <ChartTooltip
        content={({ point }) => {
          const date = point.date as Date;
          return (
            <TooltipContent
              rows={[
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
              ]}
              title={formatDateTime(date.getTime() / 1000, lang)}
            />
          );
        }}
        dateLabels={timeLabels}
      />
    </AreaChart>
  );
}

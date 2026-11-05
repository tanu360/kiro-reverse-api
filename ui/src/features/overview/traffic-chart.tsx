import { curveMonotoneX } from "d3-shape";
import { type JSX, useMemo } from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { Grid } from "@/components/charts/grid";
import {
  ChartTooltip,
  TooltipContent,
  TooltipHeader,
  type TooltipRow,
} from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import { niceTicks, YAxis } from "@/components/charts/y-axis";
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

/**
 * The x-axis labels: a time only where a bucket holds a round boundary (every 15 min for the
 * 1 h view, every hour for 6 h, every 4 h for 24 h), an empty label everywhere else and at the
 * plot's two ends.
 */
function roundTimeLabels(points: readonly TrafficPoint[], bucketMin: number, lang: Lang): string[] {
  const step = bucketMin <= 2 ? 15 : bucketMin <= 5 ? 60 : 240;
  // The plot starts at the card's padding, so a label on the first few buckets would be cut in
  // half at the card's edge; the last ones would run into the y labels.
  const edge = Math.ceil(points.length * 0.05);
  return points.map((point, index) => {
    if (index < edge || index >= points.length - edge) return "";
    for (let minute = 0; minute < bucketMin; minute += 1) {
      const at = new Date(point.date.getTime() + minute * 60_000);
      if ((at.getHours() * 60 + at.getMinutes()) % step === 0) {
        return formatTime(at.getTime() / 1000, lang);
      }
    }
    return "";
  });
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
  const tickLabels = useMemo(
    () => roundTimeLabels(points, bucketMin, lang),
    [points, bucketMin, lang],
  );
  const timeLabels = useMemo(
    () => points.map((p) => formatTime(p.date.getTime() / 1000, lang)),
    [points, lang],
  );
  const quiet = empty ? "muted" : "area";

  return (
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
      {/* Every row is a candidate, so only the round times (the non-empty labels) show. */}
      <XAxis labels={tickLabels} numTicks={Math.max(2, points.length)} />
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
            <div>
              <TooltipHeader className="flex items-baseline gap-2">
                <span className="font-mono">
                  {`${formatTime(start, lang)}–${formatTime(start + bucketMin * 60, lang)}`}
                </span>
                <span className="font-normal text-chart-tooltip-muted text-meta">
                  {labels.bucket}
                </span>
              </TooltipHeader>
              <TooltipContent rows={rows} />
            </div>
          );
        }}
        dateLabels={timeLabels}
      />
    </AreaChart>
  );
}

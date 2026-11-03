import { type JSX, useMemo } from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip, TooltipContent } from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import { formatDateTime, formatNumber, formatTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import type { TrafficPoint } from "./aggregate";
import { FAILED_COLOR, SUCCEEDED_COLOR } from "./colors";

const MARGIN = { top: 16, right: 24, bottom: 36, left: 24 };

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
  const timeLabels = useMemo(
    () => points.map((p) => formatTime(p.date.getTime() / 1000, lang)),
    [points, lang],
  );

  return (
    <AreaChart
      animationDuration={reducedMotion ? 0 : undefined}
      aspectRatio="auto"
      className="h-72 md:h-80"
      data={data}
      margin={MARGIN}
    >
      <Grid horizontal />
      <Area
        animate={!reducedMotion}
        dataKey="succeeded"
        fill={SUCCEEDED_COLOR}
        fillOpacity={0.3}
        strokeWidth={2}
      />
      <Area
        animate={!reducedMotion}
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

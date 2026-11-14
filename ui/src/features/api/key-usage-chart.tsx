import { type JSX, useMemo } from "react";
import { Area } from "@/components/charts/area";
import { AreaChart } from "@/components/charts/area-chart";
import { rightAxisMargin } from "@/components/charts/axis-fit";
import { useSettledYScale } from "@/components/charts/chart-context";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import { YAxis } from "@/components/charts/y-axis";
import { useIsMobile } from "@/hooks/use-media-query";
import type { Lang } from "@/lib/i18n";
import { bucketLabel, bucketTitle, type TimeBucket } from "@/lib/time-buckets";
import { USAGE_PLOT_HEIGHT, type UsageBar } from "./key-usage-model";

// The count labels sit in the right margin, as on the Overview traffic chart. The 8 px on the
// left keeps the first label, centred on the first point, inside a phone card's padding.
const MARGIN = { top: 8, right: 36, bottom: 28, left: 8 };

export interface UsageSeries {
  label: string;
  color: string;
}

/** Count labels in whole numbers: two requests read 0, 1, 2, not 0, 0.5 … 2. */
function WholeNumberYAxis(): JSX.Element {
  const scale = useSettledYScale();
  const ticks = scale.ticks(4).filter((tick) => Number.isInteger(tick));
  return <YAxis numTicks={4} side="right" tickValues={ticks} />;
}
// Named as the axis it wraps, so the chart keeps it out of the series' reveal clip like YAxis.
WholeNumberYAxis.displayName = "YAxis";

/**
 * Lazy-loaded area chart for one key's usage: a point per hour, day, week, month or year, with
 * `primary` and `secondary` as two areas from zero (succeeded and failed, input and output), or
 * one area for credits. The loading state is AreaChart's own sweep; an empty range keeps only the
 * time axis.
 */
export default function KeyUsageChart({
  bars,
  bucket,
  bucketSeconds,
  tzOffset,
  primary,
  secondary,
  formatValue,
  lang,
  reducedMotion,
  status = "ready",
  empty = false,
  wholeNumbers = false,
}: {
  bars: UsageBar[];
  bucket: TimeBucket;
  bucketSeconds: number;
  tzOffset: number;
  primary: UsageSeries;
  /** Omitted for credits, which have one part. */
  secondary?: UsageSeries;
  formatValue: (value: number) => string;
  lang: Lang;
  reducedMotion: boolean;
  status?: "loading" | "ready";
  empty?: boolean;
  /** Counts (requests, tokens): the axis skips fractional labels. */
  wholeNumbers?: boolean;
}): JSX.Element {
  const phone = useIsMobile();
  const data = useMemo(
    () =>
      bars.map((bar) => ({
        date: new Date(bar.start * 1000),
        name: bucketLabel(bar.start, bucket, tzOffset, lang),
        start: bar.start,
        primary: bar.primary,
        secondary: bar.secondary,
      })),
    [bars, bucket, tzOffset, lang],
  );
  // Long counts ("4,1 mi" tokens) widen the label margin; long dates get fewer labels.
  const margin = useMemo(
    () => ({
      ...MARGIN,
      right: rightAxisMargin(
        Math.max(0, ...bars.map((bar) => Math.max(bar.primary, bar.secondary))),
        MARGIN.right,
        lang,
      ),
    }),
    [bars, lang],
  );
  const labels = useMemo(() => data.map((datum) => datum.name), [data]);
  // Labels on every step-th point from the first, about five (three on a phone): evenly spaced,
  // and never on the last point, which the plot edge would push into its neighbour.
  const step = Math.max(1, Math.ceil(data.length / (phone ? 3 : 5)));

  return (
    <AreaChart
      animationDuration={reducedMotion ? 0 : undefined}
      aspectRatio="auto"
      className={USAGE_PLOT_HEIGHT}
      data={data}
      margin={margin}
      status={status}
    >
      {empty ? null : wholeNumbers ? <WholeNumberYAxis /> : <YAxis numTicks={4} side="right" />}
      <Area
        animate={!reducedMotion}
        dataKey="primary"
        fill={primary.color}
        stroke={primary.color}
      />
      {secondary ? (
        <Area
          animate={!reducedMotion}
          dataKey="secondary"
          fill={secondary.color}
          stroke={secondary.color}
        />
      ) : null}
      {/* The edge labels stop at the plot, clear of the count labels in the right margin. */}
      <XAxis clamp="plot" labels={labels} tickFilter={(_, index) => index % step === 0} />
      {empty ? null : (
        <ChartTooltip
          content={({ point }) => {
            const rows: TooltipRow[] = [
              {
                color: primary.color,
                label: primary.label,
                value: formatValue(Number(point.primary)),
              },
            ];
            if (secondary) {
              rows.push({
                color: secondary.color,
                label: secondary.label,
                value: formatValue(Number(point.secondary)),
              });
            }
            return (
              <TooltipContent
                mono
                rows={rows}
                title={bucketTitle(Number(point.start), bucket, bucketSeconds, tzOffset, lang)}
              />
            );
          }}
          showDatePill={false}
        />
      )}
    </AreaChart>
  );
}

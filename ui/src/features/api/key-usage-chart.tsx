import { type JSX, useId, useMemo } from "react";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { useChartStable, useSettledYScale } from "@/components/charts/chart-context";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { YAxis } from "@/components/charts/y-axis";
import { TRACK_COLOR } from "@/features/overview/colors";
import { useIsMobile } from "@/hooks/use-media-query";
import type { Lang } from "@/lib/i18n";
import { bucketLabel, bucketTitle, USAGE_PLOT_HEIGHT, type UsageBar } from "./key-usage-model";

// The count labels sit in the right margin, as on the Overview traffic chart. The 8 px on the
// left keeps the first label, centred on the first bar, inside a phone card's padding.
const MARGIN = { top: 8, right: 36, bottom: 28, left: 8 };

export interface UsageSeries {
  label: string;
  color: string;
}

/**
 * Diagonal hatching in one series colour, the Overview traffic bars' look: a 30 % wash with a
 * solid 3 px stripe every 6 px. Copied, not imported: the traffic chart module pulls the
 * Overview card (and its router search) into whatever chunk imports it. The name must contain
 * "Pattern": BarChart lays such children out first, where the bars' `url(#id)` fills reach them.
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

/** The empty column behind every bar, so a quiet bucket still reads as a slot on the axis. */
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

/** Count labels in whole numbers: two requests read 0, 1, 2, not 0, 0.5 … 2. */
function WholeNumberYAxis(): JSX.Element {
  const scale = useSettledYScale();
  const ticks = scale.ticks(4).filter((tick) => Number.isInteger(tick));
  return <YAxis numTicks={4} side="right" tickValues={ticks} />;
}
// Named as the axis it wraps, so the chart keeps it out of the bars' reveal clip like YAxis.
WholeNumberYAxis.displayName = "YAxis";

/**
 * Lazy-loaded bar chart for one key's usage: a bar per hour or day, `primary` hatched under
 * `secondary` (succeeded under failed, input under output), over a faint full-height track. The
 * loading state is BarChart's own skeleton; an empty range keeps only the time axis.
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
  bucket: "hour" | "day";
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
  const id = useId().replace(/:/g, "");
  const ids = { primary: `kp-${id}`, secondary: `ks-${id}` };
  const data = useMemo(
    () =>
      bars.map((bar) => ({
        name: bucketLabel(bar.start, bucket, tzOffset, lang),
        start: bar.start,
        primary: bar.primary,
        secondary: bar.secondary,
      })),
    [bars, bucket, tzOffset, lang],
  );

  return (
    <BarChart
      animationDuration={reducedMotion ? 0 : undefined}
      aspectRatio="auto"
      // Narrower gaps on a phone, so 30 daily bars still read as bars, not hairlines.
      barGap={phone ? 0.22 : 0.35}
      className={USAGE_PLOT_HEIGHT}
      data={data}
      margin={MARGIN}
      stacked
      stackGap={1}
      status={status}
      xDataKey="name"
    >
      <HatchPattern color={primary.color} id={ids.primary} />
      {secondary ? <HatchPattern color={secondary.color} id={ids.secondary} /> : null}
      {empty ? null : <BarColumnTrack />}
      {empty ? null : wholeNumbers ? <WholeNumberYAxis /> : <YAxis numTicks={4} side="right" />}
      <Bar
        animate={!reducedMotion}
        dataKey="primary"
        fill={`url(#${ids.primary})`}
        lineCap={2}
        stroke={primary.color}
      />
      {secondary ? (
        <Bar
          animate={!reducedMotion}
          dataKey="secondary"
          fill={`url(#${ids.secondary})`}
          lineCap={2}
          stroke={secondary.color}
        />
      ) : null}
      <BarXAxis maxLabels={{ base: 3, sm: 4, md: 6 }} />
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
          showCrosshair={false}
          showDatePill={false}
          showDots={false}
        />
      )}
    </BarChart>
  );
}

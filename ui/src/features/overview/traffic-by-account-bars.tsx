import type { JSX } from "react";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { Grid } from "@/components/charts/grid";
import { ChartTooltip, TooltipContent, type TooltipRow } from "@/components/charts/tooltip";
import { useIsMobile } from "@/hooks/use-media-query";

export interface AccountSeries {
  /** Data key of the series in each bucket row. */
  key: string;
  label: string;
  color: string;
}

export interface AccountBucket {
  /** The bucket's x label (its start time). */
  name: string;
  /** "10:42–10:44", for the tooltip title. */
  range: string;
  [key: string]: string | number;
}

/** Side margin of the plot: room for the first and last time label, centred on their bars. */
const SIDE = 20;

/**
 * Lazy-loaded Bklit stacked bar chart for Traffic by account: one bar per two-minute bucket of
 * the last hour, stacked by the busiest accounts and "Other accounts" (oldest on the left). The
 * tooltip lists every account's requests in the hovered bucket, with its failures after them.
 * `data` may hold fewer buckets than the hour's `slots` (traffic began a few minutes ago): the
 * plot then keeps the full-hour bar width and sits centred, growing outward as buckets arrive,
 * the older bars moving left to make room for the newest.
 */
export default function TrafficByAccountBars({
  data,
  series,
  formatCount,
  failedLabel,
  reducedMotion,
  slots = data.length,
}: {
  data: AccountBucket[];
  series: AccountSeries[];
  formatCount: (value: number) => string;
  failedLabel: (count: number) => string;
  reducedMotion: boolean;
  /** Buckets in the whole window; `data` may cover only the newest of them. */
  slots?: number;
}): JSX.Element {
  // Phones get a taller plot, so thirty bars do not turn into slivers.
  const phone = useIsMobile();
  const full = data.length >= slots;
  const share = Math.min(1, data.length / Math.max(1, slots));
  return (
    // The box keeps the full-hour height; the plot inside is as wide as its buckets need.
    <div
      className="flex w-full justify-center"
      data-slot="traffic-bars"
      style={{ aspectRatio: phone ? "2 / 1" : "4 / 1" }}
    >
      <div
        className="h-full"
        style={{
          width: full ? "100%" : `calc((100% - ${SIDE * 2}px) * ${share} + ${SIDE * 2}px)`,
        }}
      >
        <BarChart
          aspectRatio="auto"
          barGap={0.3}
          className="h-full"
          data={data}
          margin={{ top: 8, right: SIDE, bottom: 28, left: SIDE }}
          stacked
          stackGap={1}
          xDataKey="name"
        >
          {/* Grid lines only across a full hour: on a short centred plot they stop mid-card. */}
          {full ? <Grid horizontal numTicksRows={3} /> : null}
          {series.map((item) => (
            <Bar animate={!reducedMotion} dataKey={item.key} fill={item.color} key={item.key} />
          ))}
          <BarXAxis maxLabels={{ base: 3, sm: 4, md: 6 }} />
          <ChartTooltip
            content={({ point }) => {
              const rows: TooltipRow[] = series
                .filter((item) => Number(point[item.key] ?? 0) > 0)
                .map((item) => {
                  const failed = Number(point[`${item.key}Failed`] ?? 0);
                  return {
                    color: item.color,
                    label: item.label,
                    value:
                      failed > 0
                        ? `${formatCount(Number(point[item.key]))} · ${failedLabel(failed)}`
                        : formatCount(Number(point[item.key])),
                  };
                });
              return <TooltipContent mono rows={rows} title={String(point.range ?? point.name)} />;
            }}
            showCrosshair={false}
            showDatePill={false}
            showDots={false}
          />
        </BarChart>
      </div>
    </div>
  );
}

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

/**
 * Lazy-loaded Bklit stacked bar chart for Traffic by account: one bar per two-minute bucket of
 * the last hour, stacked by the busiest accounts and "Other accounts" (oldest on the left). The
 * tooltip lists every account's requests in the hovered bucket, with its failures after them.
 */
export default function TrafficByAccountBars({
  data,
  series,
  formatCount,
  failedLabel,
  reducedMotion,
}: {
  data: AccountBucket[];
  series: AccountSeries[];
  formatCount: (value: number) => string;
  failedLabel: (count: number) => string;
  reducedMotion: boolean;
}): JSX.Element {
  // Phones get a taller plot, so thirty bars do not turn into slivers.
  const phone = useIsMobile();
  return (
    <BarChart
      aspectRatio={phone ? "2 / 1" : "4 / 1"}
      barGap={0.3}
      className="w-full"
      data={data}
      // Side room for the first and last time label, centred on their bars.
      margin={{ top: 8, right: 20, bottom: 28, left: 20 }}
      stacked
      stackGap={1}
      xDataKey="name"
    >
      <Grid horizontal numTicksRows={3} />
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
  );
}

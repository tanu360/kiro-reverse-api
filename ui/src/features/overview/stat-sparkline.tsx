import type { JSX } from "react";
import { BarSparkline } from "@/components/charts/sparkline";

/**
 * The KPI tiles' bar sparkline: twelve 5-minute buckets of the current hour in the 28 px trend
 * slot, the newest bar in `color` and the older ones in the idle grey. All-zero data draws the
 * flat empty stubs. Lazy-loaded, so the chart code stays out of the overview route chunk.
 * Decorative only (the tile's delta line says the same in words).
 */
export default function StatSparkline({
  data,
  color,
  animate,
}: {
  data: readonly { value: number }[];
  color?: string;
  animate: boolean;
}): JSX.Element {
  return (
    <BarSparkline
      animate={animate}
      color={color}
      data={data}
      dataKey="value"
      highlightLast={1}
      interactive={false}
    />
  );
}

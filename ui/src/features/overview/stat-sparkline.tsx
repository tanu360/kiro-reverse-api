import type { JSX } from "react";
import { BarSparkline } from "@/components/charts/sparkline";

export interface StatSparklineProps {
  /** Oldest first; the last bar is the newest. */
  data: readonly { value: number }[];
  /** The newest bars' colour (default the series purple). */
  color?: string;
  /** How many of the newest bars take `color`; the older ones are the idle grey. Default 1. */
  highlight?: number;
  animate: boolean;
}

/**
 * The stat tiles' bar sparkline in the 28 px trend slot: the newest `highlight` bars in `color`
 * and the older ones in the idle grey. All-zero data draws the flat empty stubs. Lazy-loaded
 * (see lazy-sparkline), so the chart code stays out of the overview route chunk. Decorative
 * only (the tile's value and delta line say the same in words).
 */
export default function StatSparkline({
  data,
  color,
  highlight = 1,
  animate,
}: StatSparklineProps): JSX.Element {
  return (
    <BarSparkline
      animate={animate}
      color={color}
      data={data}
      dataKey="value"
      highlightLast={highlight}
      interactive={false}
    />
  );
}

import type { JSX } from "react";
import { BarSparkline } from "@/components/charts/sparkline";
import { STAT_TREND_HEIGHT } from "@/components/shared/stat-card";

export interface StatSparklineProps {
  /** Oldest first; the last bar is the newest. */
  data: readonly { value: number }[];
  /** The newest bars' colour (default the series purple). */
  color?: string;
  /** How many of the newest bars take `color`; the older ones are the idle grey. Default 1. */
  highlight?: number;
  /** The trend slot's height in px (STAT_TREND_HEIGHT); default the inline slot's 28. */
  height?: number;
  animate: boolean;
}

/**
 * The stat tiles' bar sparkline, as tall as its trend slot (28 px inline, 48 px aside): the newest `highlight` bars in `color`
 * and the older ones in the idle grey. All-zero data draws the flat empty stubs. Lazy-loaded
 * (see lazy-sparkline), so the chart code stays out of the overview route chunk. Decorative
 * only (the tile's value and delta line say the same in words).
 */
export default function StatSparkline({
  data,
  color,
  highlight = 1,
  height = STAT_TREND_HEIGHT.inline,
  animate,
}: StatSparklineProps): JSX.Element {
  return (
    <BarSparkline
      animate={animate}
      color={color}
      data={data}
      dataKey="value"
      height={height}
      highlightLast={highlight}
      interactive={false}
    />
  );
}

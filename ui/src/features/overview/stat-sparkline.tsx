import type { JSX } from "react";
import { AreaSparkline } from "@/components/charts/sparkline";
import { STAT_TREND_HEIGHT } from "@/components/shared/stat-card";

export interface StatSparklineProps {
  /** Oldest first; the last point is the newest. */
  data: readonly { value: number }[];
  /** The area's colour (default the series purple). */
  color?: string;
  /** Draw the area in the quiet grey instead of `color` (a failure trend with no failures). */
  idle?: boolean;
  /** The trend slot's height in px (STAT_TREND_HEIGHT); default the inline slot's 28. */
  height?: number;
  animate: boolean;
}

const AREA_IDLE_COLOR = "color-mix(in oklab, var(--muted-foreground) 60%, transparent)";

/**
 * The stat tiles' sparkline, as tall as its trend slot (28 px inline, 48 px aside): one smooth
 * line over a gradient fill, from zero so a quiet stretch reads low rather than as a swing.
 * Lazy-loaded (see lazy-sparkline), so the chart code stays out of the overview route chunk.
 * Decorative only (the tile's value and delta line say the same in words).
 */
export default function StatSparkline({
  data,
  color,
  idle = false,
  height = STAT_TREND_HEIGHT.inline,
  animate,
}: StatSparklineProps): JSX.Element {
  return (
    <AreaSparkline
      animate={animate}
      color={idle ? AREA_IDLE_COLOR : color}
      data={data}
      dataKey="value"
      fillOpacity={0.35}
      height={height}
      interactive={false}
      strokeWidth={1.75}
      yDomain={[0, undefined]}
    />
  );
}

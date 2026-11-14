import type { CSSProperties, JSX } from "react";
import { cn } from "@/lib/utils";

// A gentle two-hump wave on a 240 x 48 box, drawn once: the line and the area under it.
const LINE = "M0 34 C 20 30, 34 18, 56 20 S 92 36, 116 30 S 150 10, 176 14 S 214 30, 240 22";
const AREA = `${LINE} L 240 48 L 0 48 Z`;

/**
 * A chart's loading state shaped like a chart: a soft wave in the skeleton tint, breathing like
 * every other skeleton (index.css animate-skeleton), stretched to the slot it holds. Decorative:
 * the slot's own label says it is loading.
 */
export function ChartSkeleton({
  className,
  style,
}: {
  /** Size classes; the wave fills the box. */
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className={cn("block w-full animate-skeleton", className)}
      data-slot="chart-skeleton"
      preserveAspectRatio="none"
      style={style}
      viewBox="0 0 240 48"
    >
      <path d={AREA} fill="var(--skeleton)" fillOpacity={0.55} />
      <path
        d={LINE}
        fill="none"
        stroke="var(--skeleton)"
        strokeLinecap="round"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

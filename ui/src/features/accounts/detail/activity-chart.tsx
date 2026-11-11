import type { JSX } from "react";
import { AreaSparkline } from "@/components/charts/sparkline";

export interface ActivityPoint {
  reqs: number;
  failures: number;
}

/**
 * The sheet's last 24 hours as one smooth area of requests, failures a red fill along its foot,
 * both on one 0..peak scale so they line up. Hovering moves a dashed guide and a dot along the
 * requests and reports the hour through `onHover` (the summary line above says it in words, so
 * the drawing itself is hidden from screen readers). Loaded lazily: the chart code stays out of
 * the Accounts route chunk until a sheet opens.
 */
export default function ActivityChart({
  data,
  height,
  onHover,
}: {
  /** Oldest first, one point an hour. */
  data: readonly ActivityPoint[];
  height: number;
  onHover: (index: number | null) => void;
}): JSX.Element {
  const peak = Math.max(1, ...data.map((point) => point.reqs));
  const domain: [number, number] = [0, peak];
  const hasFailures = data.some((point) => point.failures > 0);
  return (
    <div aria-hidden="true" className="relative">
      <AreaSparkline
        animate
        color="var(--chart-1)"
        crosshair="dashed"
        data={data}
        dataKey="reqs"
        dot
        fill="solid"
        fillOpacity={0.14}
        height={height}
        onHoverChange={(index) => onHover(index)}
        strokeWidth={1.75}
        yDomain={domain}
      />
      {hasFailures ? (
        <div className="pointer-events-none absolute inset-0">
          <AreaSparkline
            animate
            color="var(--chart-negative)"
            data={data}
            dataKey="failures"
            fill="solid"
            fillOpacity={0.55}
            height={height}
            interactive={false}
            // Fill only: an hour with no failures draws nothing, not a red line along the floor.
            strokeWidth={0}
            yDomain={domain}
          />
        </div>
      ) : null}
    </div>
  );
}

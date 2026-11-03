import type { JSX } from "react";
import { AreaSparkline } from "@/components/charts/sparkline";

/** Lazy-loaded, so the chart code stays out of the overview route chunk. Decorative only. */
export default function StatSparkline({
  data,
  color,
  animate,
}: {
  data: readonly { value: number }[];
  color: string;
  animate: boolean;
}): JSX.Element {
  return (
    <AreaSparkline
      animate={animate}
      color={color}
      data={data}
      dataKey="value"
      height={32}
      interactive={false}
    />
  );
}

import { type JSX, lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatSparklineProps } from "./stat-sparkline";

const load = () => import("./stat-sparkline");
const StatSparkline = lazy(load);

// The chart chunk starts loading with the page instead of after the first data arrives, so the
// bars are drawn as soon as the numbers are, not a beat later.
void load();

/**
 * The stat tiles' bar sparkline, code-split. Until its chunk is in, the trend slot holds the
 * same placeholder as while the data loads, so nothing shifts or flashes empty.
 */
export function LazySparkline(props: StatSparklineProps): JSX.Element {
  return (
    <Suspense fallback={<TrendPlaceholder />}>
      <StatSparkline {...props} />
    </Suspense>
  );
}

/** The trend slot's loading placeholder, filling the slot (28 px inline, 48 px aside). */
export function TrendPlaceholder(): JSX.Element {
  return <Skeleton className="size-full" />;
}

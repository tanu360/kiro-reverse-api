import type { JSX } from "react";
import { Card, CardPanel } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n";
import { StatTileSkeleton } from "./stat-card";

export function LoadingState({ label }: { label?: string }): JSX.Element {
  const { t } = useT();
  const text = label ?? t("state.loading");
  return (
    <div
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-6 py-12 text-muted-foreground text-sm"
    >
      <Spinner aria-hidden="true" className="size-4" />
      <span>{text}</span>
    </div>
  );
}

const LINE_WIDTHS = ["w-2/5", "w-full", "w-11/12", "w-4/5", "w-3/5", "w-5/6"];

export function CardSkeleton({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <Card aria-hidden="true">
      <CardPanel className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton
            className={`h-4 ${LINE_WIDTHS[(index + 1) % LINE_WIDTHS.length]}`}
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder.
            key={index}
          />
        ))}
      </CardPanel>
    </Card>
  );
}

export function TableSkeleton({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}): JSX.Element {
  const cols = Math.max(1, columns);
  const style = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  return (
    <div aria-hidden="true" className="flex w-full flex-col">
      <div className="grid gap-4 border-border-subtle border-b px-2.5 py-3" style={style}>
        {Array.from({ length: cols }, (_, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells never reorder.
          <Skeleton className="h-3.5 w-2/3" key={c} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          className="grid gap-4 border-border-subtle border-b px-2.5 py-3.5 last:border-b-0"
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder.
          key={r}
          style={style}
        >
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton
              className={`h-4 ${c === 0 ? "w-4/5" : "w-3/5"}`}
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells never reorder.
              key={c}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A stat tile's placeholder, row for row (label, value, delta and trend, a 2x2 metrics grid). It
 * takes the tile's place inside a StatGroup and its own card elsewhere.
 */
export function StatCardSkeleton({
  metrics = 4,
  size,
}: {
  metrics?: number;
  size?: "display" | "kpi";
} = {}): JSX.Element {
  return <StatTileSkeleton metrics={metrics} size={size} />;
}

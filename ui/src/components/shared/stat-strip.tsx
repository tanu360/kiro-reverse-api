import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StatStripItem {
  label: string;
  value: ReactNode;
}

/*
 * Up to three numbers stay on one line at every width; four go two by two in a narrow card (a
 * phone sheet) and four across from a 28rem card. Cells are split by the subtle hairline.
 */
const GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @md:grid-cols-4",
};

const CELL: Record<number, string> = {
  1: "",
  2: "not-first:border-s",
  3: "not-first:border-s",
  4: "even:border-s nth-[n+3]:border-t not-first:@md:border-s nth-[n+3]:@md:border-t-0",
};

/**
 * A detail sheet's headline numbers: a 12 px muted label over a 16 px semibold value, flush in
 * a card (put it inside a Card with `@container`). One to four items.
 */
export function StatStrip({
  items,
  className,
}: {
  items: StatStripItem[];
  /** Layout classes (a top hairline under content above it). */
  className?: string;
}): JSX.Element {
  const count = Math.min(Math.max(items.length, 1), 4);
  return (
    <dl className={cn("grid", GRID[count], className)}>
      {items.slice(0, 4).map((item) => (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1 border-border-subtle px-4 py-3 sm:px-6",
            CELL[count],
          )}
          key={item.label}
        >
          <dt className="truncate text-meta text-muted-foreground">{item.label}</dt>
          <dd className="truncate font-semibold text-base tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

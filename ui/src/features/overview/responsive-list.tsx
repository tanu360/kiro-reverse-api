import type { JSX, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Static class names, so Tailwind sees them. The query is the nearest container: the card.
const SWITCH = {
  lg: { cards: "@lg:hidden", table: "hidden @lg:block" },
  "4xl": { cards: "@4xl:hidden", table: "hidden @4xl:block" },
} as const;

/**
 * Cards on a narrow card, the table once the card is wide enough for every column. The
 * switch is a container query on the card's width, not the viewport: with a persistent
 * sidebar a tablet's content column is too narrow for these tables. Both are rendered and the
 * hidden one is `display: none`, so it is out of the tab order and the accessibility tree.
 */
export function ResponsiveList<T>({
  at,
  table,
  rows,
  getRowId,
  renderCard,
  loading = false,
  emptyState,
  caption,
  listClassName,
}: {
  at: keyof typeof SWITCH;
  table: ReactNode;
  rows: readonly T[];
  getRowId: (row: T, index: number) => string;
  renderCard: (row: T) => ReactNode;
  loading?: boolean;
  emptyState?: ReactNode;
  caption?: string;
  listClassName?: string;
}): JSX.Element {
  let cards: ReactNode;
  if (loading && rows.length === 0) {
    cards = (
      <div aria-busy="true" className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards never reorder.
          <Skeleton className="h-20 w-full rounded-xl" key={index} />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    cards = emptyState;
  } else {
    cards = (
      <ul aria-label={caption} className={cn("grid gap-2", listClassName)}>
        {rows.map((row, index) => (
          <li className="min-w-0" key={getRowId(row, index)}>
            {renderCard(row)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      <div className={cn("min-w-0", SWITCH[at].cards)} data-slot="responsive-cards">
        {cards}
      </div>
      <div className={cn("min-w-0", SWITCH[at].table)} data-slot="responsive-table">
        {table}
      </div>
    </>
  );
}

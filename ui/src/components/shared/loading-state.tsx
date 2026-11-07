import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n";
import { placeholderKeys } from "@/lib/utils";

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

export function TableSkeleton({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}): JSX.Element {
  const cols = Math.max(1, columns);
  const style = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  const cells = placeholderKeys("cell", cols);
  return (
    <div aria-hidden="true" className="flex w-full flex-col">
      <div className="grid gap-4 border-border-subtle border-b px-2.5 py-3" style={style}>
        {cells.map((cell) => (
          <Skeleton className="h-3.5 w-2/3" key={cell} />
        ))}
      </div>
      {placeholderKeys("row", rows).map((row) => (
        <div
          className="grid gap-4 border-border-subtle border-b px-2.5 py-3.5 last:border-b-0"
          key={row}
          style={style}
        >
          {cells.map((cell, c) => (
            <Skeleton className={`h-4 ${c === 0 ? "w-4/5" : "w-3/5"}`} key={cell} />
          ))}
        </div>
      ))}
    </div>
  );
}

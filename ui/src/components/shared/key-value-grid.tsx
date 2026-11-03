import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

const COLUMN_CLASS = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
} as const;

export function KeyValueGrid({
  items,
  columns = 2,
}: {
  items: { label: string; value: ReactNode; mono?: boolean; span?: 1 | 2 }[];
  columns?: 1 | 2 | 3;
}): JSX.Element {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm", COLUMN_CLASS[columns])}>
      {items.map((item) => (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            item.span === 2 && columns > 1 && "sm:col-span-2",
          )}
          key={item.label}
        >
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className={cn("min-w-0 break-words", item.mono && "font-mono text-[0.8125rem]")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

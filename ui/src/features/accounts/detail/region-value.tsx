import type { JSX } from "react";

/** A region as a fact row shows it, with a muted note when a setting sends traffic elsewhere. */
export function RegionValue({ region, note }: { region: string; note?: string }): JSX.Element {
  if (!note) return <>{region}</>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>{region}</span>
      <span className="text-muted-foreground text-xs">{note}</span>
    </span>
  );
}

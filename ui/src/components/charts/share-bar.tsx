"use client";

import { cn } from "@/lib/utils";

interface ShareBarProps {
  /** The part, e.g. one model's credits. */
  value: number;
  /** The whole. Default: 1, so `value` can be a 0..1 share. */
  max?: number;
  /** Bar colour: a series token, e.g. `var(--chart-1)`. */
  color: string;
  /** Layout classes only (width, e.g. `max-w-40`). */
  className?: string;
}

/**
 * A 4 px ranked share bar (value / max) on the chart-grid track. It needs no
 * Legend context, so table cells and cards use the same bar as
 * `LegendProgress`. Decorative: pair it with a visible value.
 */
export function ShareBar({ value, max = 1, color, className }: ShareBarProps) {
  const ratio = max > 0 && Number.isFinite(value) ? value / max : 0;
  const width = Math.min(100, Math.max(0, ratio * 100));

  return (
    <span
      aria-hidden
      className={cn(
        "block h-1 w-full min-w-0 overflow-hidden rounded-full bg-chart-grid",
        className,
      )}
      data-slot="share-bar"
    >
      {/* The colour is series data, so it stays an inline style. */}
      <span
        className="block h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${width}%`, backgroundColor: color }}
      />
    </span>
  );
}

ShareBar.displayName = "ShareBar";

"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { intFmt } from "../chart-formatters";

export interface TooltipRow {
  color: string;
  label: string;
  value: string | number;
}

interface TooltipContentProps {
  title?: ReactNode;
  /** Muted meta-size text after the title, e.g. the bucket size or the account. */
  meta?: ReactNode;
  /** Set the title in the mono face (time ranges, IDs). Default: false */
  mono?: boolean;
  rows: TooltipRow[];
  /** Optional additional content (e.g., markers) */
  children?: ReactNode;
}

interface TooltipHeaderProps {
  children: ReactNode;
  /** Muted meta-size text after the title on the same baseline; truncates when long. */
  meta?: ReactNode;
  /** Set the title in the mono face (time ranges, IDs). Default: false */
  mono?: boolean;
  /** Layout classes only. */
  className?: string;
}

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}

/**
 * Popover-style header row: medium-weight label separated from the body by a
 * full-width border, with an optional muted `meta` after it. Use it at the top
 * of custom `ChartTooltip` `content`.
 */
export function TooltipHeader({ children, meta, mono = false, className }: TooltipHeaderProps) {
  const withMeta = hasContent(meta);
  return (
    <div
      className={cn(
        "border-border-subtle border-b px-3.5 py-2.5 text-left font-medium text-chart-tooltip-foreground text-sm tabular-nums",
        withMeta && "flex min-w-0 items-baseline gap-2",
        className,
      )}
    >
      {withMeta || mono ? (
        <span className={cn("shrink-0", mono && "font-mono")}>{children}</span>
      ) : (
        children
      )}
      {withMeta ? (
        <span className="min-w-0 truncate font-normal text-chart-tooltip-muted text-meta">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

TooltipHeader.displayName = "TooltipHeader";

export function TooltipContent({ title, meta, mono, rows, children }: TooltipContentProps) {
  const hasBody = rows.length > 0 || Boolean(children);
  return (
    <div>
      {hasContent(title) ? (
        <TooltipHeader meta={meta} mono={mono}>
          {title}
        </TooltipHeader>
      ) : null}
      {hasBody && (
        <div className="px-3.5 py-3">
          {rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  className="flex items-center justify-between gap-6"
                  key={`${row.label}-${row.color}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="truncate text-chart-tooltip-muted text-sm">{row.label}</span>
                  </div>
                  <span className="text-right font-medium text-chart-tooltip-foreground text-sm tabular-nums">
                    {typeof row.value === "number" ? intFmt(row.value) : row.value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {children && (
            <div
              className={
                rows.length > 0
                  ? "mt-2 transition-opacity duration-200 ease-out"
                  : "transition-opacity duration-200 ease-out"
              }
            >
              {children}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

TooltipContent.displayName = "TooltipContent";

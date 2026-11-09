import { ArrowRight02Icon, DatabaseAddIcon, DatabaseIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY, formatCompact, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Token use in two fixed lines, so every row of a table is the same height: the total, then
 * "input → output" (as OpenRouter's activity log reads) with a database mark and the cached
 * count after it when the request read from the cache (a database-plus mark and the written
 * count when it only wrote). The mark keeps the line short enough for the Requests column; the
 * tooltip names every count, and screen readers hear "N cached" / "N to cache". The second line
 * is always there and never wraps; it truncates.
 */
export function TokenCell({
  inTokens,
  outTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  muteZero = false,
  detailClassName,
}: {
  inTokens: number;
  outTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** A muted dash instead of "0" when nothing was used (a failed request). */
  muteZero?: boolean;
  /** Merged into the cell, e.g. a width floor (`min-w-48`) for a crowded table column. */
  detailClassName?: string;
}): JSX.Element {
  const { t, lang } = useT();
  const total = inTokens + outTokens;
  const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;

  if (muteZero && total === 0 && !hasCache) {
    return <span className={cn("text-muted-foreground", detailClassName)}>{EMPTY}</span>;
  }

  const rows: [string, number][] = [
    [t("tokens.in"), inTokens],
    [t("tokens.out"), outTokens],
  ];
  if (hasCache) {
    rows.push([t("tokens.cacheRead"), cacheReadTokens], [t("tokens.cacheWrite"), cacheWriteTokens]);
  }
  rows.push([t("tokens.total"), total]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // Not a tab stop: the total and breakdown are visible text, the tooltip only adds exact
          // counts, and rows (Requests) already open a detail view with every number.
          <span
            className={cn(
              "inline-flex min-w-0 max-w-full flex-col items-start gap-1 text-left tabular-nums",
              detailClassName,
            )}
          />
        }
      >
        <span className="font-medium">{total === 0 ? "0" : formatCompact(total)}</span>
        <span className="flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap text-meta text-muted-foreground leading-none">
          <span className="sr-only">{t("tokens.in")}</span>
          <span>{formatCompact(inTokens)}</span>
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground/70"
            icon={ArrowRight02Icon}
          />
          <span className="sr-only">{t("tokens.out")}</span>
          <span>{formatCompact(outTokens)}</span>
          {hasCache ? (
            <span className="ms-1.5 flex min-w-0 items-center gap-1">
              <span className="sr-only">
                {cacheReadTokens > 0
                  ? t("tokens.cached", { n: formatCompact(cacheReadTokens) })
                  : t("tokens.toCache", { n: formatCompact(cacheWriteTokens) })}
              </span>
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground/70"
                icon={cacheReadTokens > 0 ? DatabaseIcon : DatabaseAddIcon}
              />
              <span aria-hidden="true" className="min-w-0 truncate">
                {formatCompact(cacheReadTokens > 0 ? cacheReadTokens : cacheWriteTokens)}
              </span>
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 py-0.5">
          {rows.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{formatNumber(value, lang)}</dd>
            </div>
          ))}
        </dl>
      </TooltipPopup>
    </Tooltip>
  );
}

import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY, formatCompact, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Token use in two fixed lines, so every row of a table is the same height: the total with
 * "In X · Out Y" beside it, then "Cache read A, write B" when the request used the cache.
 * Neither line wraps; the breakdown and the cache line truncate, and the tooltip carries every
 * exact count.
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
        {/*
          One line: the breakdown truncates rather than wrapping under the total, so a narrow
          column keeps every row two lines tall (the tooltip has the exact counts).
        */}
        <span className="flex max-w-full flex-nowrap items-baseline gap-x-2">
          <span className="shrink-0 font-medium">{total === 0 ? "0" : formatCompact(total)}</span>
          <span className="min-w-0 truncate whitespace-nowrap text-meta text-muted-foreground leading-none">
            {`${t("tokens.in")} ${formatCompact(inTokens)} · ${t("tokens.out")} ${formatCompact(outTokens)}`}
          </span>
        </span>
        {hasCache ? (
          <span className="block max-w-full truncate whitespace-nowrap text-meta text-muted-foreground leading-none">
            {t("tokens.cacheDetail", {
              read: formatCompact(cacheReadTokens),
              write: formatCompact(cacheWriteTokens),
            })}
          </span>
        ) : null}
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

import { Fragment, type JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompact, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function TokenCell({
  inTokens,
  outTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  detailClassName,
}: {
  inTokens: number;
  outTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Merged into the breakdown line, e.g. a narrower width floor for a crowded table. */
  detailClassName?: string;
}): JSX.Element {
  const { t, lang } = useT();
  const total = inTokens + outTokens;
  const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;

  // The breakdown wraps only between its parts ("In 14.5K", "Out 688", "Cache read 9.9K, write
  // 0"), never inside one, so a narrow column never strands a word such as "Cache".
  const parts = [
    `${t("tokens.in")} ${formatCompact(inTokens)}`,
    `${t("tokens.out")} ${formatCompact(outTokens)}`,
  ];
  if (hasCache) {
    parts.push(
      t("tokens.cacheDetail", {
        read: formatCompact(cacheReadTokens),
        write: formatCompact(cacheWriteTokens),
      }),
    );
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
          <span className="inline-flex flex-col items-start gap-0.5 text-left" />
        }
      >
        <span className="font-medium">{total === 0 ? "0" : formatCompact(total)}</span>
        <span
          className={cn(
            "min-w-48 max-w-60 whitespace-normal text-muted-foreground text-xs leading-snug",
            detailClassName,
          )}
        >
          {parts.map((part, index) => (
            <Fragment key={part}>
              {index > 0 ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </span>
      </TooltipTrigger>
      <TooltipPopup>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 py-0.5">
          {rows.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right">{formatNumber(value, lang)}</dd>
            </div>
          ))}
        </dl>
      </TooltipPopup>
    </Tooltip>
  );
}

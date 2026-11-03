import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompact, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";

export function TokenCell({
  inTokens,
  outTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
}: {
  inTokens: number;
  outTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): JSX.Element {
  const { t, lang } = useT();
  const total = inTokens + outTokens;
  const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;

  let detail = `${t("tokens.in")} ${formatCompact(inTokens)} · ${t("tokens.out")} ${formatCompact(outTokens)}`;
  if (hasCache) {
    detail += ` · ${t("tokens.cacheDetail", {
      read: formatCompact(cacheReadTokens),
      write: formatCompact(cacheWriteTokens),
    })}`;
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
        <span className="font-medium tabular-nums">{total === 0 ? "0" : formatCompact(total)}</span>
        <span className="min-w-48 max-w-60 whitespace-normal text-muted-foreground text-xs tabular-nums leading-snug">
          {detail}
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

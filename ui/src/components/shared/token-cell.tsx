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
          <span
            className="inline-flex flex-col items-start gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            // Focusable so keyboard users can reach the exact numbers in the tooltip.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip trigger needs focus.
            tabIndex={0}
          />
        }
      >
        <span className="font-medium tabular-nums">{total === 0 ? "0" : formatCompact(total)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">{detail}</span>
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

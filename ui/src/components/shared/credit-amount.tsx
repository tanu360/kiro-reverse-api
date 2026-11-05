import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCredits, formatCreditsExact, roundsToZero } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * A credit amount with `digits` decimals, in tabular figures so amounts line up in a column. One
 * too small to show ("<0.01") has the exact amount as its tooltip. `format` replaces the default
 * fixed-decimals text, for the same `digits`.
 */
export function CreditAmount({
  value,
  digits = 2,
  format,
}: {
  value: number;
  digits?: number;
  format?: (value: number) => string;
}): JSX.Element {
  const { lang } = useT();
  const text = format ? format(value) : formatCredits(value, digits, lang);
  if (!roundsToZero(value, digits)) return <span className="tabular-nums">{text}</span>;
  return (
    <Tooltip>
      {/* Not a tab stop, like the other cell tooltips; the text itself says "less than". */}
      <TooltipTrigger render={<span className="tabular-nums" />}>{text}</TooltipTrigger>
      <TooltipPopup>{formatCreditsExact(value, lang)}</TooltipPopup>
    </Tooltip>
  );
}

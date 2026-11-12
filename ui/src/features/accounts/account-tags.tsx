import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";

/**
 * An account's tags as small neutral pills (emails in them masked under privacy). The first
 * `max` show; the rest fold into a "+N" pill whose tooltip, and screen reader text, lists them.
 * A long tag is cut with an ellipsis. `wrap` lets the pills wrap where the row has room to grow
 * (the detail sheet); a list row keeps them on one line.
 */
export function TagBadges({
  tags,
  max,
  wrap = false,
}: {
  tags: readonly string[] | undefined;
  max: number;
  wrap?: boolean;
}): JSX.Element | null {
  const { t, lang } = useT("accounts");
  const mask = useMaskText();
  if (!tags || tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max).map((tag) => mask(tag));
  return (
    <span
      className={cn("flex min-w-0 shrink-0 items-center gap-1", wrap && "shrink flex-wrap")}
      data-slot="account-tags"
    >
      {shown.map((tag) => (
        <Badge key={tag} size="sm" tone="neutral">
          <span className="max-w-24 truncate">{mask(tag)}</span>
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          {/* Not a tab stop: the sheet lists every tag. */}
          <TooltipTrigger render={<Badge size="sm" tone="neutral" />}>
            {/* A count, not copy: the same "+N" in every language. */}
            <span aria-hidden="true">+{formatNumber(rest.length, lang)}</span>
            <span className="sr-only">
              {t("metadata.moreTagsLabel", { count: rest.length, tags: rest.join(", ") })}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{rest.join(", ")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

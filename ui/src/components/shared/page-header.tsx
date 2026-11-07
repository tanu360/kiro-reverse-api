import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

/**
 * Title block and actions share a row while both fit; otherwise the actions wrap below. The
 * actions take their own width first and the title block the rest, down to 12rem, so one or two
 * actions stay beside the title on a phone and wrap only when they do not fit. The decision
 * follows the space the header actually has, not the viewport.
 *
 * The app's type scale starts here, after the sign-in pages: a calm semibold title (20 px on
 * phones, 22 px from sm up) over a 14 px muted description. Cards step down to a 15 px title
 * (SectionCard), tables to 13 px headers over 14 px cells, and meta lines to 12-13 px.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-48 grow basis-0 flex-col gap-1.5">
        {/*
          The title row is always the buttons' height (36 / 32 / coarse 40, the default Button
          step), so the title centres on the actions beside it and the first card starts at the
          same height on every page, with or without actions.
        */}
        <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 sm:min-h-8 pointer-coarse:min-h-10">
          <h1 className="text-balance font-semibold text-xl leading-tight sm:text-title">
            {title}
          </h1>
          {meta}
        </div>
        {description ? (
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div
          className="flex max-w-full flex-wrap items-center gap-2"
          data-slot="page-header-actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The page header's Refresh. `outline` (the default) is a secondary (soft fill) button with an
 * icon and a label, the same size as every other header action. `icon` is a quiet icon-only button (its
 * colour changes on hover, no fill) with the label as its name and tooltip, for a header whose
 * other actions carry the colour. While `fetching`, the button's own loading state shows a
 * spinner in place of the icon and clicks are ignored. `size="sm"` is the card-header step,
 * beside other small card actions.
 */
export function RefreshButton({
  fetching,
  onRefresh,
  label,
  variant = "outline",
  size = "default",
}: {
  fetching: boolean;
  onRefresh: () => void;
  /** Defaults to the common "Refresh". */
  label?: string;
  variant?: "outline" | "icon";
  /** `sm` for a card header (Button sm / icon-sm); `default` for a page header. */
  size?: "default" | "sm";
}): JSX.Element {
  const { t } = useT();
  const text = label ?? t("actions.refresh");
  const iconOnly = variant === "icon";
  const button = (
    <Button
      aria-label={iconOnly ? text : undefined}
      data-slot="refresh-button"
      loading={fetching}
      onClick={() => {
        if (!fetching) onRefresh();
      }}
      size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
      variant={iconOnly ? "quiet" : "secondary"}
    >
      <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
      {iconOnly ? null : text}
    </Button>
  );
  if (!iconOnly) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{text}</TooltipPopup>
    </Tooltip>
  );
}

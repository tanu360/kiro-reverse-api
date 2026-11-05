import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Title block and actions share a row while both fit; otherwise the actions wrap below. The
 * decision follows the space the header actually has (a 20rem title basis plus the actions'
 * own width), not the viewport, so a persistent sidebar or a narrow window never squeezes the
 * title or description under the buttons.
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
      <div className="flex min-w-0 grow basis-80 flex-col gap-1.5">
        {/* With actions, the title row is the buttons' height, so the two share a centre line. */}
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1",
            actions ? "min-h-8" : undefined,
          )}
        >
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
 * The page header's Refresh. `outline` (the default) is an outline button with an icon and a
 * label, the same size as every other header action. `icon` is a quiet icon-only button (its
 * colour changes on hover, no fill) with the label as its name and tooltip, for a header whose
 * other actions carry the colour. While `fetching`, the icon spins and the button is inert. It
 * stays focusable (aria-disabled, not disabled), so keyboard focus is not dropped mid-refresh.
 */
export function RefreshButton({
  fetching,
  onRefresh,
  label,
  variant = "outline",
}: {
  fetching: boolean;
  onRefresh: () => void;
  /** Defaults to the common "Refresh". */
  label?: string;
  variant?: "outline" | "icon";
}): JSX.Element {
  const { t } = useT();
  const text = label ?? t("actions.refresh");
  const iconOnly = variant === "icon";
  const button = (
    <Button
      aria-busy={fetching || undefined}
      aria-disabled={fetching || undefined}
      aria-label={iconOnly ? text : undefined}
      className="aria-disabled:pointer-events-none"
      data-slot="refresh-button"
      onClick={() => {
        if (!fetching) onRefresh();
      }}
      size={iconOnly ? "icon" : "default"}
      variant={iconOnly ? "quiet" : "outline"}
    >
      <HugeiconsIcon
        icon={Refresh01Icon}
        aria-hidden="true"
        className={cn(fetching && "motion-safe:animate-spin")}
      />
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

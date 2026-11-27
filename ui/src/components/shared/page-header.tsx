import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CompactOnPhone } from "@/components/ui/compact-actions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Title block and actions share a row while both fit; otherwise the actions wrap below. The
 * actions take their own width first and the title block the rest, down to 12rem, so one or two
 * actions stay beside the title on a phone and wrap only when they do not fit. The decision
 * follows the space the header actually has, not the viewport.
 *
 * On phones (below sm) the description runs the full width under both, instead of a narrow
 * column beside the actions: a grid of the title row and the actions over the description, the
 * actions dropping under the description when they do not fit beside the title.
 *
 * The app's type scale starts here (index.css): a semibold 20 px title over a 14 px muted
 * description. Cards step down to a 16 px title (SectionCard), tables to 14 px heads and cells,
 * and meta lines to 12 px.
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
    <PageHeaderLayout
      actions={actions}
      description={description}
      heading={
        <>
          {/* A title with no break in it (an API key's name) wraps instead of overflowing. */}
          <h1 className="min-w-0 text-balance font-semibold text-title wrap-anywhere">{title}</h1>
          {meta}
        </>
      }
    />
  );
}

/** The phone header's room for the title beside the actions (12rem) and the gap between (12 px). */
const PHONE_TITLE_MIN = 192;
const PHONE_GAP = 12;

/**
 * Whether the actions sit under the description on a phone: when their buttons (8 px apart) and
 * the gap leave the title less than 12rem. Measured before paint and again on every resize, and
 * again when the actions mount later (a page whose actions appear once it has data).
 */
function usePhoneActionsWrap(hasActions: boolean): {
  headerRef: RefObject<HTMLDivElement | null>;
  actionsRef: RefObject<HTMLDivElement | null>;
  wrapped: boolean;
} {
  const headerRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const actions = actionsRef.current;
    if (!(hasActions && header && actions) || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const items = Array.from(actions.children) as HTMLElement[];
      const width =
        items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) +
        Math.max(0, items.length - 1) * 8;
      setWrapped(width + PHONE_GAP + PHONE_TITLE_MIN > header.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(actions);
    for (const item of Array.from(actions.children)) observer.observe(item);
    return () => observer.disconnect();
  }, [hasActions]);

  return { headerRef, actionsRef, wrapped };
}

/**
 * PageHeader's frame around any title row (`heading`): also the user panel's loading header,
 * whose title row is bars, so the page does not move when the key arrives.
 */
export function PageHeaderLayout({
  heading,
  description,
  actions,
  busy,
}: {
  heading: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
}): JSX.Element {
  const { headerRef, actionsRef, wrapped } = usePhoneActionsWrap(Boolean(actions));
  return (
    <div
      aria-busy={busy || undefined}
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1.5"
      ref={headerRef}
    >
      <div className="flex min-w-48 grow basis-0 flex-col gap-1.5 max-sm:contents">
        {/*
          The title row is always the buttons' height (32 on phones, 36, 40 on a touch tablet:
          the default Button step), so the title centres on the actions beside it and the first card starts at the
          same height on every page, with or without actions.
        */}
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 sm:min-h-9 sm:pointer-coarse:min-h-10 max-sm:col-start-1 max-sm:row-start-1">
          {heading}
        </div>
        {description ? (
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed max-sm:col-span-2 max-sm:row-start-2">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "flex max-w-full flex-wrap items-center gap-2 max-sm:col-start-2 max-sm:row-start-1",
            // Under the description, 16 px below it as the wrapped row is from sm up.
            wrapped &&
              (description
                ? "max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-3 max-sm:mt-2.5"
                : "max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-2 max-sm:mt-2.5"),
          )}
          data-slot="page-header-actions"
          data-wrapped={wrapped ? "" : undefined}
          ref={actionsRef}
        >
          {/* On a phone icon buttons, as every header's actions there. */}
          <CompactOnPhone>{actions}</CompactOnPhone>
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

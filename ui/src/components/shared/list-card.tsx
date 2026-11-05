import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { JSX, ReactElement, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/*
 * The list item that replaces a table row on narrow containers (API keys, Backups, Accounts,
 * Requests, Overview activity). One anatomy everywhere:
 *   header  leading slot (checkbox, logo) · title · badge … trailing slot (row kebab)
 *   meta    a muted 13 px line
 *   body    the caller's content (a stats grid, a meter)
 *   footer  pushed to the bottom (mt-auto), so cards in one grid row line up
 * "card" is a small Card (size sm: p-3, gap-2); "row" is the same content with no border or fill, for rows
 * divided inside one card (ListCardGroup, or DataTable cardLayout="divided").
 */

const CARD_OPEN_HOVER = "has-[[data-slot=list-card-open]:hover]:bg-(--card-hover)";
// The selected tint is laid over the card's own fill as an image, so the card stays opaque.
const CARD_SELECTED =
  "border-primary/40 bg-[linear-gradient(var(--row-selected),var(--row-selected))]";
const ROW_CLASS = "relative flex min-w-0 flex-col gap-2 px-4 py-3 transition-colors sm:px-5";
const ROW_OPEN_HOVER = "has-[[data-slot=list-card-open]:hover]:bg-(--row-hover)";
const ROW_SELECTED = "bg-(--row-selected)";

// The open button stretches over the whole item (::after), so a tap anywhere opens it; the
// leading and trailing slots sit above that layer and keep their own clicks.
const OPEN_BUTTON = {
  card: "outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-ring focus-visible:after:outline-solid focus-visible:after:outline-offset-2",
  row: "outline-none after:absolute after:inset-0 focus-visible:after:outline-1 focus-visible:after:outline-ring focus-visible:after:outline-solid focus-visible:after:-outline-offset-1",
} as const;

export interface ListCardProps {
  title: ReactNode;
  /** Before the title: a selection checkbox, a logo. Stays clickable over the open layer. */
  leading?: ReactNode;
  /** After the title, on the same line (a status or kind badge). */
  badge?: ReactNode;
  /** The trailing slot: the row's kebab menu or one icon action. */
  action?: ReactNode;
  /** A muted 13 px line under the header. */
  meta?: ReactNode;
  /** Pinned to the bottom of the item. */
  footer?: ReactNode;
  children?: ReactNode;
  variant?: "card" | "row";
  selected?: boolean;
  /** Makes the whole item open something (a detail sheet); the title becomes the button. */
  onOpen?: () => void;
  /** The open button's accessible name when the title alone is not enough ("Open details…"). */
  openLabel?: string;
  /** Layout classes only (h-full, col-span). */
  className?: string;
  /** The element to render, e.g. `<li />` or `<article />`. */
  render?: ReactElement;
}

export function ListCard({
  title,
  leading,
  badge,
  action,
  meta,
  footer,
  children,
  variant = "card",
  selected = false,
  onOpen,
  openLabel,
  className,
  render,
}: ListCardProps): JSX.Element {
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2" data-slot="list-card-header">
        {leading ? (
          <div className="relative z-[1] flex shrink-0 items-center">{leading}</div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onOpen ? (
            <button
              aria-label={openLabel}
              className={cn(
                "min-w-0 cursor-pointer truncate text-left font-medium text-foreground text-sm/5",
                OPEN_BUTTON[variant],
              )}
              data-slot="list-card-open"
              onClick={onOpen}
              type="button"
            >
              {title}
            </button>
          ) : (
            <div className="min-w-0 truncate font-medium text-foreground text-sm/5">{title}</div>
          )}
          {badge ? <div className="flex shrink-0 items-center">{badge}</div> : null}
        </div>
        {action ? (
          // Pulled into the padding so a 32 px icon button does not make the header taller.
          <div className="relative z-[1] -my-1.5 -me-1.5 flex shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      {meta ? (
        <div className="min-w-0 text-meta text-muted-foreground" data-slot="list-card-meta">
          {meta}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div className="relative z-[1] mt-auto min-w-0" data-slot="list-card-footer">
          {footer}
        </div>
      ) : null}
    </>
  );

  const state = { "data-selected": selected ? "" : undefined, "data-slot": "list-card" };

  if (variant === "row") {
    return (
      <ListRowShell
        className={cn(onOpen && ROW_OPEN_HOVER, selected && ROW_SELECTED, className)}
        render={render}
        {...state}
      >
        {content}
      </ListRowShell>
    );
  }

  return (
    <Card
      className={cn(
        "min-w-0 transition-colors",
        onOpen && CARD_OPEN_HOVER,
        selected && CARD_SELECTED,
        className,
      )}
      render={render}
      size="sm"
      {...state}
    >
      {content}
    </Card>
  );
}

function ListRowShell({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn(ROW_CLASS, className) }, props),
    render,
  });
}

/**
 * Equal-height cards: one column, two from a 42rem container (@2xl), with an odd last card
 * spanning both so no row is half empty. Each child (an `<li>`) stretches its card to the row.
 * It queries the nearest `@container` (DataTable's own wrapper, or the caller's).
 */
export const CARD_GRID_CLASS =
  "grid gap-2 @2xl:grid-cols-2 *:flex *:*:min-w-0 *:*:flex-1 @2xl:[&>*:last-child:nth-child(odd)]:col-span-2";

export function CardGrid({ className, render, ...props }: useRender.ComponentProps<"ul">) {
  return useRender({
    defaultTagName: "ul",
    props: mergeProps<"ul">({ className: cn(CARD_GRID_CLASS, className) }, props),
    render,
  });
}

/**
 * Rows divided inside one card (hairlines, no nested borders): the `divided` list. Put
 * `<ListCard variant="row" render={<li />} />` items in it.
 */
export function ListCardGroup({
  children,
  className,
  render,
  ...props
}: {
  children: ReactNode;
  /** Layout classes only. */
  className?: string;
  /** The list element; a `<ul>` by default. */
  render?: ReactElement;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <Card className={cn("overflow-hidden", className)} divided render={render ?? <ul />} {...props}>
      {children}
    </Card>
  );
}

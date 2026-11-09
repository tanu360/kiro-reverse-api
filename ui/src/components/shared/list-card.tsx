import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { JSX, ReactElement, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, placeholderKeys } from "@/lib/utils";

/*
 * The list item that replaces a table row on narrow containers (API keys, Backups, Accounts,
 * Requests, Overview activity). One anatomy everywhere:
 *   header  leading slot (checkbox, logo) · title · badge … trailing slot (row kebab)
 *   meta    a muted 12 px line
 *   body    the caller's content (a stats grid, a meter)
 *   footer  pushed to the bottom (mt-auto), so cards in one grid row line up
 * "card" is a small Card (size sm: p-3, gap-2); "row" is the same content with no border or fill, for rows
 * divided inside one card (ListCardGroup, or DataTable cardLayout="divided").
 */

const CARD_OPEN_HOVER = "has-[[data-slot=list-card-open]:hover]:bg-(--card-hover)";
// The selected tint is laid over the card's own fill as an image, so the card stays opaque.
const CARD_SELECTED = "border-primary/40 bg-linear-to-b from-(--row-selected) to-(--row-selected)";
const ROW_CLASS = "relative flex min-w-0 flex-col gap-3 px-4 py-4 transition-colors sm:px-6";
const ROW_OPEN_HOVER = "has-[[data-slot=list-card-open]:hover]:bg-(--row-hover)";
const ROW_SELECTED = "bg-(--row-selected)";

// The open button stretches over the whole item (::after), so a tap anywhere opens it; the
// leading and trailing slots sit above that layer and keep their own clicks.
const OPEN_BUTTON = {
  card: "outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-ring focus-visible:after:outline-solid focus-visible:after:outline-offset-2",
  row: "outline-none after:absolute after:inset-0 focus-visible:after:outline-1 focus-visible:after:outline-ring focus-visible:after:outline-solid focus-visible:after:-outline-offset-1",
} as const;

interface ListCardProps {
  title: ReactNode;
  /** Before the title: a selection checkbox, a logo. Stays clickable over the open layer. */
  leading?: ReactNode;
  /** After the title, on the same line (a status or kind badge). */
  badge?: ReactNode;
  /** The trailing slot: the row's kebab menu or one icon action. */
  action?: ReactNode;
  /** A muted 12 px line under the header. */
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
      {/*
        The leading and trailing slots are one title line tall (h-6) and the row aligns to its
        start, so a checkbox and a kebab sit on the title's line even when the badges wrap under
        it, and two cards in one grid row keep their kebabs at the same height.
      */}
      <div className="flex min-w-0 items-start gap-2" data-slot="list-card-header">
        {leading ? (
          <div className="relative z-1 flex h-6 shrink-0 items-center">{leading}</div>
        ) : null}
        {/*
          The title and its badges wrap: when both do not fit, the badges drop under the title
          instead of crushing it to a few letters (a key that is disabled and over its limit).
          The title pads its 20 px line to the 24 px of a badge (py-0.5), so its first line is
          24 px whether a badge sits beside it or wraps under it.
        */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {onOpen ? (
            <button
              aria-label={openLabel}
              className={cn(
                "min-w-0 max-w-full cursor-pointer truncate py-0.5 text-left font-medium text-foreground text-sm/5",
                OPEN_BUTTON[variant],
              )}
              data-slot="list-card-open"
              onClick={onOpen}
              type="button"
            >
              {title}
            </button>
          ) : (
            <div className="min-w-0 max-w-full truncate py-0.5 font-medium text-foreground text-sm/5">
              {title}
            </div>
          )}
          {badge ? <div className="flex shrink-0 items-center">{badge}</div> : null}
        </div>
        {action ? (
          // One title line tall: a 32 px icon button centres on the title's line and overflows
          // into the padding instead of making the header taller.
          <div className="relative z-1 -me-1.5 flex h-6 shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      {meta ? (
        <div className="min-w-0 text-meta text-muted-foreground" data-slot="list-card-meta">
          {meta}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div className="relative z-1 mt-auto min-w-0" data-slot="list-card-footer">
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

// One text line of a skeleton: the bar centred in the line box of the text it stands for, so the
// placeholder is as tall as the card it becomes.
const SKELETON_LINE = { title: "flex h-6 items-center gap-2", text: "flex h-5 items-center" };
const SKELETON_BODY_WIDTHS = ["w-3/5", "w-2/5", "w-1/2"] as const;

/**
 * A ListCard's loading placeholder, built on the same anatomy and line heights: the header line
 * (an optional leading checkbox, the title and an optional trailing action), the meta line, then
 * `lines` body lines, an optional usage `meter` and a `stats` grid. Pick the parts the real card
 * has, so the list keeps its height when the data arrives.
 */
export function ListCardSkeleton({
  variant = "card",
  leading = false,
  action = false,
  meta = true,
  lines = 0,
  meter = false,
  stats = 0,
  className,
}: {
  variant?: "card" | "row";
  /** A checkbox before the title. */
  leading?: boolean;
  /** A trailing action (a switch and the row menu). */
  action?: boolean;
  meta?: boolean;
  /** Body lines of 14 px text under the meta line. */
  lines?: number;
  /** A usage meter: its figures over a thin track. */
  meter?: boolean;
  /** Columns of label-over-value stats at the bottom. */
  stats?: number;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const content = (
    <>
      <div className={SKELETON_LINE.title}>
        {leading ? <Skeleton className="size-4 shrink-0" /> : null}
        <Skeleton className="h-4 w-2/3" />
        {action ? <Skeleton className="ms-auto h-5 w-12 shrink-0 rounded-full" /> : null}
      </div>
      {meta ? (
        <div className={SKELETON_LINE.text}>
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : null}
      {placeholderKeys("line", lines).map((key, index) => (
        <div className={SKELETON_LINE.text} key={key}>
          <Skeleton
            className={cn("h-3.5", SKELETON_BODY_WIDTHS[index % SKELETON_BODY_WIDTHS.length])}
          />
        </div>
      ))}
      {meter ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      ) : null}
      {stats > 0 ? (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${stats}, minmax(0, 1fr))` }}
        >
          {placeholderKeys("stat", stats).map((key) => (
            <div className="flex flex-col gap-0.5" key={key}>
              <div className={SKELETON_LINE.text}>
                <Skeleton className="h-3 w-3/5" />
              </div>
              <div className={SKELETON_LINE.text}>
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  if (variant === "row") {
    return (
      <div
        aria-hidden="true"
        className={cn("flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6", className)}
        data-slot="list-card-skeleton"
      >
        {content}
      </div>
    );
  }
  return (
    <Card
      aria-hidden="true"
      className={cn("min-w-0", className)}
      data-slot="list-card-skeleton"
      size="sm"
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
 * It queries the nearest `@container` (DataTable's own wrapper, or the caller's). The single
 * column is explicit (minmax(0, 1fr)): an implicit auto track would grow to the min-content of
 * a long unbreakable title and push every card past its panel.
 */
export const CARD_GRID_CLASS =
  "grid grid-cols-1 gap-2 @2xl:grid-cols-2 *:flex *:*:min-w-0 *:*:flex-1 @2xl:[&>*:last-child:nth-child(odd)]:col-span-2";

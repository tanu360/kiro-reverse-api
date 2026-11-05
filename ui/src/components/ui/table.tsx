"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type React from "react";
import { useEffect, useRef } from "react";
import { observeWidth } from "@/hooks/use-element-width";
import { cn } from "@/lib/utils";

/**
 * Marks a horizontal scroller with what it hides: `data-overflow-start` once it has scrolled
 * away from the start, `data-overflow-end` while there is more past the end. Sticky columns
 * draw their edge from these, so a pinned column shows a divider only while something actually
 * slides under it. Attributes, not state: scrolling never re-renders the table.
 */
function useOverflowEdges(ref: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const update = () => {
      // Right-to-left scrollers count scrollLeft down from 0.
      const offset = Math.abs(scroller.scrollLeft);
      const hidden = scroller.scrollWidth - scroller.clientWidth;
      scroller.toggleAttribute("data-overflow-start", offset > 0.5);
      scroller.toggleAttribute("data-overflow-end", hidden - offset > 0.5);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const stops = [observeWidth(scroller, update)];
    const table = scroller.firstElementChild;
    if (table) stops.push(observeWidth(table, update));
    return () => {
      scroller.removeEventListener("scroll", update);
      for (const stop of stops) stop();
    };
  }, [ref]);
}

export type TableVariant = "default" | "card";

export type TableProps = React.ComponentProps<"table"> & {
  variant?: TableVariant;
  render?: useRender.ComponentProps<"div">["render"];
};

export function Table({
  className,
  variant = "default",
  render,
  ...props
}: TableProps): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useOverflowEdges(scrollerRef);
  const defaultProps = {
    children: (
      <table
        className={cn(
          // Rows are split by hairlines only (border-subtle), no column dividers. Figures are
          // tabular, so right-aligned numbers line up on their digits and widths hold on refetch.
          "w-full caption-bottom in-data-[variant=card]:border-separate in-data-[variant=card]:border-spacing-0 text-sm tabular-nums",
          className,
        )}
        data-slot="table"
        {...props}
      />
    ),
    className: "scrollbar-x relative w-full overflow-x-auto",
    "data-slot": "table-container",
    "data-variant": variant,
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, {}),
    ref: scrollerRef,
    render,
  });
}

export function TableHeader({
  className,
  ...props
}: React.ComponentProps<"thead">): React.ReactElement {
  return (
    <thead
      className={cn("not-in-data-[variant=card]:bg-(--row-head) [&_tr]:border-b [&_tr]:border-border-subtle", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

export function TableBody({
  className,
  ...props
}: React.ComponentProps<"tbody">): React.ReactElement {
  return (
    <tbody
      className={cn(
        "relative in-data-[variant=card]:rounded-xl before:pointer-events-none before:absolute before:inset-px not-in-data-[variant=card]:before:hidden before:rounded-[calc(var(--radius-xl)-1px)] [&_tr:last-child]:border-0 in-data-[variant=card]:*:[tr]:border-0 in-data-[variant=card]:*:[tr]:*:[td]:border-b in-data-[variant=card]:*:[tr]:*:[td]:bg-card in-data-[variant=card]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[variant=card]:*:[tr]:*:[td]:first:border-s in-data-[variant=card]:*:[tr]:first:*:[td]:border-t in-data-[variant=card]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[variant=card]:*:[tr]:*:[td]:last:border-e in-data-[variant=card]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[variant=card]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-card-hover in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-card-selected",
        className,
      )}
      data-slot="table-body"
      {...props}
    />
  );
}

export function TableFooter({
  className,
  ...props
}: React.ComponentProps<"tfoot">): React.ReactElement {
  return (
    <tfoot
      className={cn(
        "border-t in-data-[variant=card]:border-none bg-transparent not-in-data-[variant=card]:bg-card-hover font-medium [&>tr]:last:border-b-0",
        className,
      )}
      data-slot="table-footer"
      {...props}
    />
  );
}

export function TableRow({
  className,
  ...props
}: React.ComponentProps<"tr">): React.ReactElement {
  return (
    <tr
      className={cn(
        // Hover is the --row-hover tint; a row whose menu is open keeps half the selected tint,
        // so it is clear which row the menu belongs to.
        "relative border-border-subtle border-b transition-colors not-in-data-[variant=card]:hover:bg-(--row-hover) not-in-data-[variant=card]:has-aria-expanded:bg-(--row-selected)/50 not-in-data-[variant=card]:data-[state=selected]:bg-(--row-selected) not-in-data-[variant=card]:data-[state=selected]:hover:bg-(--row-selected-hover)",
        className,
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ComponentProps<"th">): React.ReactElement {
  return (
    <th
      className={cn(
        "h-10 whitespace-nowrap px-2.5 text-left align-middle font-normal text-meta text-muted-foreground leading-none has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0",
        className,
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.ComponentProps<"td">): React.ReactElement {
  return (
    <td
      className={cn(
        "whitespace-nowrap bg-clip-padding p-2.5 in-data-[slot=table-footer]:py-3.5 align-middle leading-none in-data-[variant=card]:first:ps-[calc(--spacing(2.5)-1px)] in-data-[variant=card]:last:pe-[calc(--spacing(2.5)-1px)] has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0",
        className,
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

export function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">): React.ReactElement {
  return (
    <caption
      className={cn(
        "in-data-[variant=card]:my-4 mt-4 text-muted-foreground text-sm",
        className,
      )}
      data-slot="table-caption"
      {...props}
    />
  );
}

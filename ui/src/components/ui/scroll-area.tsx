"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type React from "react";
import { cn } from "@/lib/utils";

/**
 * A scroll box with no vertical bar and a thin sideways one. `scrollFade` fades whichever edge
 * still has content past it, on both axes: the top and bottom of a tall panel, and the start and
 * end of a row wider than its box (tab strips, chip rows), 24 px at most.
 * `scrollbarGutter` gives the sideways bar its own 10 px lane under an overflowing row, so the bar
 * never covers the row:
 *   true       the lane is part of the box (bottom padding while the row overflows), for a row
 *              with nothing below it to lend the space, such as a sticky chip bar
 *   "overlap"  the lane takes no layout space: the bar is drawn 10 px lower, in the gap below the
 *              box (a toolbar's gap, a card's padding), so a row is as tall with and without
 *              overflow and the spacing around it stays even. Margins on the box still apply.
 */
export function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  fill = false,
  clampContentMinWidth = true,
  overscrollContain = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  scrollbarGutter?: boolean | "overlap";
  fill?: boolean;
  clampContentMinWidth?: boolean;
  overscrollContain?: boolean;
}): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Root
      className={cn("size-full min-h-0", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn(
          "h-full rounded-[inherit] outline-none transition-shadow focus-outline-inset",
          overscrollContain &&
            "data-has-overflow-y:overscroll-y-contain data-has-overflow-x:overscroll-x-contain",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem]",
          scrollbarGutter === true && "data-has-overflow-x:pb-2.5",
        )}
        data-slot="scroll-area-viewport"
      >
        <ScrollAreaPrimitive.Content
          className={cn(fill && "size-full")}
          data-slot="scroll-area-content"
          style={clampContentMinWidth ? { minWidth: 0 } : undefined}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {/* Kiro: no vertical bar, ever (see the scrollbar rules in index.css); only the sideways one. */}
      <HorizontalScrollBar
        className={scrollbarGutter === "overlap" ? "translate-y-2.5" : undefined}
      />
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "m-1 flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

/** The sideways bar on its own: a 6 px round thumb that shows while scrolling or hovered. */
export function HorizontalScrollBar(
  props: Omit<ScrollAreaPrimitive.Scrollbar.Props, "orientation">,
): React.ReactElement {
  return <ScrollBar orientation="horizontal" {...props} />;
}

export { ScrollAreaPrimitive };

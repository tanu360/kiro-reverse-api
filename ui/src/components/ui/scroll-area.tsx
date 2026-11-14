"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type React from "react";
import { cn } from "@/lib/utils";

/**
 * A scroll box without scrollbars (none shows anywhere in the app, index.css), scrolled by wheel,
 * touch and keys. `scrollFade` fades whichever edge still has content past it, on both axes: the
 * top and bottom of a tall panel, and the start and end of a row wider than its box (tab strips,
 * chip rows), 24 px at most, so the fades say where more content sits.
 */
export function ScrollArea({
  className,
  children,
  scrollFade = false,
  fill = false,
  clampContentMinWidth = true,
  overscrollContain = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  fill?: boolean;
  clampContentMinWidth?: boolean;
  overscrollContain?: boolean;
}): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Root className={cn("size-full min-h-0", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        className={cn(
          "h-full rounded-[inherit] outline-none transition-shadow focus-outline-inset",
          overscrollContain &&
            "data-has-overflow-y:overscroll-y-contain data-has-overflow-x:overscroll-x-contain",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem]",
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
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

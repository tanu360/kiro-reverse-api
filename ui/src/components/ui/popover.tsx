"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type React from "react";
import { cn } from "@/lib/utils";

export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root;

export function PopoverTrigger({
  className,
  children,
  ...props
}: PopoverPrimitive.Trigger.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

export function PopoverPopup({
  children,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  flush = false,
  anchor,
  collisionPadding = 16,
  portalProps,
  ...props
}: PopoverPrimitive.Popup.Props & {
  portalProps?: PopoverPrimitive.Portal.Props;
  /** The space kept from the viewport edge: the 16 px phone gutter, as menus (menu.tsx). */
  collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"];
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  tooltipStyle?: boolean;
  /**
   * No inner padding and no scroll of its own: the content lays out its rows and edges, and keeps
   * within --available-height with its own scroller (the tester's model picker).
   */
  flush?: boolean;
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  return (
    <PopoverPrimitive.Portal {...portalProps}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        // At most 90 % of the viewport wide and, on phones, its viewport (below) 90 % tall. z-70:
        // above the toast layer (toast.tsx, z-60), so a toast never covers an open popup.
        className="z-70 h-(--positioner-height) w-(--positioner-width) max-w-[min(var(--available-width),90vw)] transition-[top,left,right,bottom,transform] data-instant:transition-none"
        collisionPadding={collisionPadding}
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-popover-foreground outline-none transition-[width,height,scale,opacity] duration-100 has-data-[slot=calendar]:rounded-xl data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            // A tooltip-style popover is drawn as the tooltip (tooltip.tsx); any other is the one
            // popup sheet (index.css popup-surface), as menus and selects.
            tooltipStyle
              ? "popup-surface w-fit text-pretty rounded-lg text-xs"
              : "popup-surface rounded-lg text-sm",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip max-sm:max-h-[min(var(--available-height),90dvh)] px-(--viewport-inline-padding) has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              tooltipStyle
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : flush
                  ? "[--viewport-inline-padding:0px]"
                  : "not-data-transitioning:overflow-y-auto py-4 [--viewport-inline-padding:--spacing(4)]",
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

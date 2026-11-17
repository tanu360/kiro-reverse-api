"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import * as React from "react";
import {
  type SegmentedControlSize,
  segmentedControlIndicatorSurfaceClassName,
  segmentedControlItemLayoutClassName,
  segmentedControlItemSizeClassNames,
  segmentedControlSlideClassName,
  segmentedControlTrackClassName,
} from "@/components/ui/segmented-control";
import { sidebarMenuButtonVariants } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type TabsVariant = "default" | "underline" | "nav";
type TabsSize = SegmentedControlSize;

const TabsListContext: React.Context<{ size: TabsSize; variant: TabsVariant }> =
  React.createContext<{ size: TabsSize; variant: TabsVariant }>({
    size: "default",
    variant: "default",
  });

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props): React.ReactElement {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-2 data-[orientation=vertical]:flex-row", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

/**
 * `default`: the segmented control (the sign-in theme toggle), the same sizes and sliding
 * indicator. `underline`: page-level tabs over a full-width hairline, the active one underlined
 * in purple; the strip scrolls sideways on its own, fading at an edge it can still scroll past.
 * `nav`: a settings-style section list (the API key dialog) drawn as the app sidebar's own rows
 * (sidebarMenuButtonVariants): the active row takes the sidebar's selected tint, nothing slides.
 */
export function TabsList({
  variant = "default",
  size = "default",
  className,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  size?: TabsSize;
  variant?: TabsVariant;
}): React.ReactElement {
  const list = (
    <TabsPrimitive.List
      className={cn(
        "relative z-0 flex w-fit items-center justify-center gap-x-0.5 text-muted-foreground",
        "data-[orientation=vertical]:flex-col",
        variant === "default"
          ? // The segmented control's frame (the sign-in theme toggle): 6 px tabs in an 8 px track.
            cn(segmentedControlTrackClassName, "*:data-[slot=tabs-tab]:rounded-md")
          : variant === "nav"
            ? // The sidebar menu's column (SidebarMenu): full-width rows 2 px apart.
              "w-full min-w-0 items-stretch gap-0.5"
            : // Page-level tabs: left-aligned over a full-width hairline, the active one underlined.
              "w-max min-w-full justify-start gap-x-1 data-[orientation=horizontal]:border-b data-[orientation=vertical]:px-1 data-[orientation=horizontal]:py-1 *:data-[slot=tabs-tab]:grow-0 *:data-[slot=tabs-tab]:hover:bg-accent",
        className,
      )}
      data-size={size}
      data-slot="tabs-list"
      {...props}
    >
      <TabsListContext.Provider value={{ size, variant }}>{children}</TabsListContext.Provider>
      {variant === "nav" ? null : (
        <TabsPrimitive.Indicator
          className={cn(
            "absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom)",
            segmentedControlSlideClassName,
            variant === "underline"
              ? "z-10 bg-primary data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px data-[orientation=horizontal]:translate-y-px"
              : cn("-z-1", segmentedControlIndicatorSurfaceClassName),
          )}
          data-slot="tab-indicator"
        />
      )}
    </TabsPrimitive.List>
  );

  if (variant !== "underline") {
    return list;
  }
  return (
    <div
      className="scroll-fade-x min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
      data-slot="tabs-list-scroller"
    >
      {list}
    </div>
  );
}

export function TabsTab({
  className,
  size,
  ...props
}: TabsPrimitive.Tab.Props & {
  size?: TabsSize;
}): React.ReactElement {
  const context = React.useContext(TabsListContext);
  const resolvedSize: TabsSize = size ?? context.size;

  if (context.variant === "nav") {
    // The sidebar row, with Base UI's data-active (a bare attribute) standing in for the
    // sidebar's data-active="true".
    return (
      <TabsPrimitive.Tab
        className={cn(
          sidebarMenuButtonVariants(),
          "data-active:bg-sidebar-row-selected data-active:font-medium data-active:text-sidebar-foreground data-active:hover:bg-sidebar-row-selected data-active:[&>svg]:text-sidebar-foreground",
          className,
        )}
        data-slot="tabs-tab"
        {...props}
      />
    );
  }

  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative flex shrink-0 grow cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent font-medium text-sm transition-[color,background-color,box-shadow] hover:text-foreground focus-outline-inner data-disabled:pointer-events-none data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:text-foreground data-disabled:opacity-64",
        segmentedControlItemLayoutClassName,
        segmentedControlItemSizeClassNames[resolvedSize],
        // Phones: a little less side padding, so three or four tabs fit at 360 px.
        "max-sm:px-2.5",
        // A count badge in a tab (coss p-tabs-10) goes muted while its tab is not the active one.
        "not-data-active:**:data-[slot=badge]:text-muted-foreground",
        className,
      )}
      data-size={resolvedSize}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props): React.ReactElement {
  return (
    <TabsPrimitive.Panel
      // The panel is a tab stop (Base UI sets tabIndex 0). Its outline sits on the inner edge, so
      // a flush panel's ring stays inside the card instead of painting over the card's border.
      className={cn("flex-1 rounded-lg focus-outline-inset", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

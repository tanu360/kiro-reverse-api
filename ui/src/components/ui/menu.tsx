"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type * as React from "react";
import { withMarqueeText } from "@/components/ui/marquee-text";
import {
  CheckedDot,
  POPUP_CHECK_ROW_CLASS,
  POPUP_GROUP_LABEL_CLASS,
  POPUP_INDICATOR_CLASS,
  POPUP_ROW_CLASS,
  POPUP_ROW_META_CLASS,
  POPUP_SEPARATOR_CLASS,
} from "@/components/ui/popup-row";
import { cn } from "@/lib/utils";

/*
 * Menu rows are the select rows (popup-row.tsx, after the sign-in language picker) on the same
 * popup-surface sheet. Action rows lead with a 16 px muted icon; radio and checkbox rows mark the
 * chosen one with the CheckedDot at the row's end and the accent text colour.
 */
const MENU_ACTION_ROW =
  "data-inset:ps-8.5 data-[variant=destructive]:text-destructive-foreground [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current";

export const Menu: typeof MenuPrimitive.Root = MenuPrimitive.Root;

const MenuPortal: typeof MenuPrimitive.Portal = MenuPrimitive.Portal;

export function MenuTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.Trigger.Props): React.ReactElement {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

export function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "end",
  alignOffset,
  side = "bottom",
  anchor,
  collisionPadding = 16,
  portalProps,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  /**
   * The space kept between the popup and the viewport edge. 16 px by default: the phone
   * gutter, so an end-aligned header menu lines up with the page content instead of the edge.
   */
  collisionPadding?: MenuPrimitive.Positioner.Props["collisionPadding"];
  portalProps?: MenuPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <MenuPortal {...portalProps}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        // z-70: above the toast layer (toast.tsx, z-60), so a toast never covers an open menu.
        className="z-70"
        collisionPadding={collisionPadding}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            // Kiro: the one popup sheet (index.css popup-surface) instead of t3code's dropdown glass.
            "popup-surface popup-width relative flex origin-(--transform-origin) outline-none transition-[opacity,scale] duration-100 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          {/* At most 22rem tall (a part row shows there is more), 90dvh on a short screen, fading at an
              edge it can still scroll past; a label wider than the popup (index.css popup-width) slides when its row is highlighted. */}
          <div className="scroll-fade-y max-h-[min(var(--available-height),22rem,90dvh)] w-full overflow-y-auto p-1">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPortal>
  );
}

export function MenuGroup(props: MenuPrimitive.Group.Props): React.ReactElement {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

export function MenuItem({
  className,
  inset,
  variant = "default",
  children,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}): React.ReactElement {
  return (
    <MenuPrimitive.Item
      className={cn(POPUP_ROW_CLASS, MENU_ACTION_ROW, className)}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    >
      {withMarqueeText(children)}
    </MenuPrimitive.Item>
  );
}

export function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props): React.ReactElement {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

/**
 * A radio row: the label, then the CheckedDot on the chosen one. `meta` adds muted trailing text
 * such as a count; with it the dot's place is kept on every row, so the counts line up.
 */
export function MenuRadioItem({
  className,
  children,
  meta,
  ...props
}: MenuPrimitive.RadioItem.Props & { meta?: React.ReactNode }): React.ReactElement {
  return (
    <MenuPrimitive.RadioItem
      className={cn(POPUP_ROW_CLASS, POPUP_CHECK_ROW_CLASS, className)}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2.5">{withMarqueeText(children)}</span>
      {meta === undefined ? (
        <MenuPrimitive.RadioItemIndicator className={POPUP_INDICATOR_CLASS}>
          <CheckedDot />
        </MenuPrimitive.RadioItemIndicator>
      ) : (
        <>
          <span className={POPUP_ROW_META_CLASS}>{meta}</span>
          <MenuPrimitive.RadioItemIndicator
            className="invisible ps-3 in-data-checked:visible"
            keepMounted
          >
            <CheckedDot />
          </MenuPrimitive.RadioItemIndicator>
        </>
      )}
    </MenuPrimitive.RadioItem>
  );
}

export function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}): React.ReactElement {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(POPUP_GROUP_LABEL_CLASS, "data-inset:ps-8.5", className)}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props): React.ReactElement {
  return (
    <MenuPrimitive.Separator
      className={cn(POPUP_SEPARATOR_CLASS, className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

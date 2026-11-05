"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronRightIcon } from "@hugeicons/core-free-icons";
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
  POPUP_SWITCH_THUMB_CLASS,
  POPUP_SWITCH_TRACK_CLASS,
} from "@/components/ui/popup-row";
import { cn } from "@/lib/utils";

/*
 * Menu rows are the select rows (popup-row.tsx, after the sign-in language picker) on the same
 * popup-surface sheet. Action rows lead with a 16 px muted icon; radio and checkbox rows mark the
 * chosen one with the CheckedDot at the row's end and the accent text colour.
 */
const MENU_ACTION_ROW =
  "data-inset:ps-8.5 data-[variant=destructive]:text-destructive-foreground [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current";

export const MenuCreateHandle: typeof MenuPrimitive.createHandle =
  MenuPrimitive.createHandle;

export const Menu: typeof MenuPrimitive.Root = MenuPrimitive.Root;

export const MenuPortal: typeof MenuPrimitive.Portal = MenuPrimitive.Portal;

export function MenuTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.Trigger.Props): React.ReactElement {
  return (
    <MenuPrimitive.Trigger
      className={className}
      data-slot="menu-trigger"
      {...props}
    >
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
  portalProps,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  portalProps?: MenuPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <MenuPortal {...portalProps}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50"
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            // Kiro: the one popup sheet (index.css popup-surface) instead of t3code's dropdown glass.
            "popup-surface popup-width relative flex origin-(--transform-origin) rounded-lg text-foreground outline-none transition-[opacity,scale] duration-100 focus:outline-none data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          {/* At most 22rem tall (a part row shows there is more), fading at an edge it can still
              scroll past; a label wider than the popup (index.css popup-width) slides when its row is highlighted. */}
          <div className="scroll-fade-y max-h-[min(var(--available-height),22rem)] w-full overflow-y-auto p-1">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPortal>
  );
}

export function MenuGroup(
  props: MenuPrimitive.Group.Props,
): React.ReactElement {
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
      className={cn(
        POPUP_ROW_CLASS,
        MENU_ACTION_ROW,
        className,
      )}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    >
      {withMarqueeText(children)}
    </MenuPrimitive.Item>
  );
}

export function MenuLinkItem({
  className,
  inset,
  variant = "default",
  closeOnClick = true,
  ...props
}: MenuPrimitive.LinkItem.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}): React.ReactElement {
  return (
    <MenuPrimitive.LinkItem
      className={cn(
        POPUP_ROW_CLASS,
        MENU_ACTION_ROW,
        className,
      )}
      closeOnClick={closeOnClick}
      data-inset={inset}
      data-slot="menu-link-item"
      data-variant={variant}
      {...props}
    />
  );
}

export function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}): React.ReactElement {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        POPUP_ROW_CLASS,
        variant === "switch"
          ? "justify-between gap-4 pe-1.5 data-checked:text-foreground"
          : POPUP_CHECK_ROW_CLASS,
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="min-w-0">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator className={POPUP_SWITCH_TRACK_CLASS} keepMounted>
            <span className={POPUP_SWITCH_THUMB_CLASS} />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2.5">{withMarqueeText(children)}</span>
          <MenuPrimitive.CheckboxItemIndicator className={POPUP_INDICATOR_CLASS}>
            <CheckedDot />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioGroup(
  props: MenuPrimitive.RadioGroup.Props,
): React.ReactElement {
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
      className={cn(
        POPUP_GROUP_LABEL_CLASS,
        "data-inset:ps-8.5",
        className,
      )}
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

export function MenuShortcut({
  className,
  ...props
}: React.ComponentProps<"kbd">): React.ReactElement {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground text-xs tracking-normal",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

export function MenuSub(
  props: MenuPrimitive.SubmenuRoot.Props,
): React.ReactElement {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

export function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}): React.ReactElement {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        POPUP_ROW_CLASS,
        "data-inset:ps-8.5 data-popup-open:bg-accent [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" className="-me-1 ms-auto size-4" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
}): React.ReactElement {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  MenuPrimitive,
  MenuCreateHandle as DropdownMenuCreateHandle,
  Menu as DropdownMenu,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup as DropdownMenuContent,
  MenuGroup as DropdownMenuGroup,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup as DropdownMenuSubContent,
};

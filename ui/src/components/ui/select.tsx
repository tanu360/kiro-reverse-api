"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronDownIcon, ChevronUpIcon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import {
  CheckedDot,
  POPUP_CHECK_ROW_CLASS,
  POPUP_GROUP_LABEL_CLASS,
  POPUP_INDICATOR_CLASS,
  POPUP_ROW_CLASS,
  POPUP_ROW_META_CLASS,
  POPUP_SEPARATOR_CLASS,
} from "@/components/ui/popup-row";
import { withMarqueeText } from "@/components/ui/marquee-text";
import { cn } from "@/lib/utils";

export const Select: typeof SelectPrimitive.Root = SelectPrimitive.Root;

/*
 * The trigger is a form field (index.css --field-*, the sign-in password field's soft fill): a
 * faint tint, a hairline border, a deeper tint on hover and while open, and a soft purple border
 * on keyboard focus, with no ring. Sizes match the input and the button: 36 / 32 px by default,
 * 44 / 40 px lg (the sign-in field), 32 / 28 px sm, and 40 px on a coarse pointer (44 lg), with
 * a 44 px hit area (the ::after layer).
 */
export const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg border border-field-border bg-field text-left text-base text-foreground outline-none transition-[background-color,border-color] duration-150 hover:bg-field-hover focus-visible:border-field-border-focus focus-visible:bg-field-focus data-popup-open:bg-field-hover data-disabled:pointer-events-none data-disabled:opacity-64 aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      fit: "field",
      size: "default",
    },
    variants: {
      /**
       * `field` (default): a form field, as wide as its column. `content`: as wide as the chosen
       * option, for toolbars and pagers (a "25 / page" select).
       */
      fit: {
        content: "w-fit",
        field: "w-full min-w-0",
      },
      size: {
        // Touch screens get a real 40 px trigger, as the input (pointer-coarse sorts after sm:).
        default: "min-h-9 px-[calc(--spacing(3)-1px)] sm:min-h-8 pointer-coarse:min-h-10",
        lg: "min-h-11 px-[calc(--spacing(3)-1px)] sm:min-h-10 pointer-coarse:min-h-11",
        sm: "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7 pointer-coarse:min-h-10",
      },
    },
  },
);

export const selectTriggerIconClassName = "-me-0.5 size-4 shrink-0";

export interface SelectButtonProps extends useRender.ComponentProps<"button"> {
  size?: VariantProps<typeof selectTriggerVariants>["size"];
}

export function SelectButton({
  className,
  size,
  render,
  children,
  ...props
}: SelectButtonProps): React.ReactElement {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: (
      <>
        <span className="min-w-0 flex-1 truncate text-left in-data-placeholder:text-placeholder">
          {children}
        </span>
        <HugeiconsIcon icon={ChevronDownIcon} aria-hidden="true" className={selectTriggerIconClassName} />
      </>
    ),
    className: cn(selectTriggerVariants({ size }), "min-w-0", className),
    "data-slot": "select-button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function SelectTrigger({
  className,
  size = "default",
  fit = "field",
  children,
  ...props
}: SelectPrimitive.Trigger.Props &
  VariantProps<typeof selectTriggerVariants>): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ fit, size }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <HugeiconsIcon icon={ChevronDownIcon} className={selectTriggerIconClassName} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectValue({
  className,
  ...props
}: SelectPrimitive.Value.Props): React.ReactElement {
  return (
    <SelectPrimitive.Value
      className={cn(
        "flex-1 truncate data-placeholder:text-placeholder",
        className,
      )}
      data-slot="select-value"
      {...props}
    />
  );
}

export function SelectPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = true,
  anchor,
  collisionPadding = 16,
  portalProps,
  fit = "field",
  ...props
}: SelectPrimitive.Popup.Props & {
  portalProps?: SelectPrimitive.Portal.Props;
  /** The space kept from the viewport edge: the 16 px phone gutter, as menus (menu.tsx). */
  collisionPadding?: SelectPrimitive.Positioner.Props["collisionPadding"];
  /**
   * Kiro: "field" (default) makes the list at least as wide as its field-like trigger, growing
   * to fit its longest option up to max(trigger, 14rem) (index.css popup-width-field); "content"
   * lets it grow past a narrow, flat trigger (a bare label such as the sign-in language picker)
   * to fit its options, as menus do (index.css popup-width).
   */
  fit?: "field" | "content";
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  return (
    <SelectPrimitive.Portal {...portalProps}>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        anchor={anchor}
        // z-70: above the toast layer (toast.tsx, z-60), so a toast never covers an open list.
        className="z-70 select-none"
        collisionPadding={collisionPadding}
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-lg text-foreground outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-lg)-1px)] before:bg-linear-to-b before:from-50% before:from-popup"
            data-slot="select-scroll-up-arrow"
          >
            <HugeiconsIcon icon={ChevronUpIcon} className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollUpArrow>
          {/* The one popup sheet (index.css popup-surface), the same as menus. */}
          {/* At least as wide as the trigger, growing to fit its longest option up to
              max(trigger, 14rem) (index.css popup-width-field, or popup-width with fit="content"),
              and at most 22rem tall, fading at an edge it can still scroll past; a label still too
              long slides when its row is highlighted. */}
          <div
            className={cn(
              "popup-surface relative h-full rounded-lg",
              fit === "field" ? "popup-width-field" : "popup-width",
            )}
          >
            <SelectPrimitive.List
              className={cn(
                "scroll-fade-y max-h-[min(var(--available-height),22rem,90dvh)] overflow-y-auto p-1",
                className,
              )}
              data-slot="select-list"
            >
              {children}
            </SelectPrimitive.List>
          </div>
          <SelectPrimitive.ScrollDownArrow
            className="bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-lg)-1px)] before:bg-linear-to-t before:from-50% before:from-popup"
            data-slot="select-scroll-down-arrow"
          >
            <HugeiconsIcon icon={ChevronDownIcon} className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/**
 * One option as the sign-in language picker draws it: the label (icons inline before it), then,
 * on the chosen option, a CheckedDot at the row's end. `meta` adds muted trailing text such as a
 * count; with it the dot's place is kept on every row, so the counts line up.
 * The label starts 12 px in from the popup's outer edge (1 px border, the list's 4 px, then
 * ps-1.75), the same as the default trigger's value (1 px border, then 11 px). The popup lines
 * the chosen option's text up with the trigger's, so equal insets keep the popup square over
 * the trigger instead of 1 px to its left.
 */
export function SelectItem({
  className,
  children,
  meta,
  ...props
}: SelectPrimitive.Item.Props & { meta?: React.ReactNode }): React.ReactElement {
  return (
    <SelectPrimitive.Item
      className={cn(POPUP_ROW_CLASS, POPUP_CHECK_ROW_CLASS, "ps-1.75", className)}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 items-center gap-2.5 [&_svg:not([class*='text-'])]:text-muted-foreground">
        {withMarqueeText(children)}
      </SelectPrimitive.ItemText>
      {meta === undefined ? (
        <SelectPrimitive.ItemIndicator className={POPUP_INDICATOR_CLASS}>
          <CheckedDot />
        </SelectPrimitive.ItemIndicator>
      ) : (
        <>
          <span className={POPUP_ROW_META_CLASS}>{meta}</span>
          <SelectPrimitive.ItemIndicator
            className="invisible ps-3 in-data-selected:visible"
            keepMounted
          >
            <CheckedDot />
          </SelectPrimitive.ItemIndicator>
        </>
      )}
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props): React.ReactElement {
  return (
    <SelectPrimitive.Separator
      className={cn(POPUP_SEPARATOR_CLASS, className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

export function SelectGroup(
  props: SelectPrimitive.Group.Props,
): React.ReactElement {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectLabel({
  className,
  ...props
}: SelectPrimitive.Label.Props): React.ReactElement {
  return (
    <SelectPrimitive.Label
      className={cn(
        "not-in-data-[slot=field]:mb-2 inline-flex cursor-default items-center gap-2 font-medium text-foreground text-sm/5",
        className,
      )}
      data-slot="select-label"
      {...props}
    />
  );
}

export function SelectGroupLabel(
  props: SelectPrimitive.GroupLabel.Props,
): React.ReactElement {
  return (
    <SelectPrimitive.GroupLabel
      className={POPUP_GROUP_LABEL_CLASS}
      data-slot="select-group-label"
      {...props}
    />
  );
}

export { SelectPrimitive, SelectPopup as SelectContent };

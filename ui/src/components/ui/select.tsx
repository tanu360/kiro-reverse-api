"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import {
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

export const Select: typeof SelectPrimitive.Root = SelectPrimitive.Root;

/*
 * The trigger is a form field (index.css --field-*, the sign-in password field's soft fill): a
 * faint tint, a hairline border, a deeper tint on hover and while open, and a soft purple border
 * on keyboard focus, with no ring. Sizes match the input and the button: 36 / 32 px by default,
 * 44 / 40 px lg (the sign-in field), 32 / 28 px sm. Coarse pointers keep a 44 px hit area (the
 * ::after layer).
 */
export const selectTriggerVariants = cva(
  "relative inline-flex w-full min-w-36 cursor-pointer select-none items-center justify-between gap-2 rounded-lg border border-field-border bg-field text-left text-base text-foreground outline-none transition-[background-color,border-color] duration-150 hover:bg-field-hover focus-visible:border-field-border-focus focus-visible:bg-field-focus data-popup-open:bg-field-hover data-disabled:pointer-events-none data-disabled:opacity-64 aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
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
        <ChevronDownIcon aria-hidden="true" className={selectTriggerIconClassName} />
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
  children,
  ...props
}: SelectPrimitive.Trigger.Props &
  VariantProps<typeof selectTriggerVariants>): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronDownIcon className={selectTriggerIconClassName} />
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
  portalProps,
  ...props
}: SelectPrimitive.Popup.Props & {
  portalProps?: SelectPrimitive.Portal.Props;
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
        className="z-50 select-none"
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-lg text-foreground outline-none"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-lg)-1px)] before:bg-linear-to-b before:from-50% before:from-popup"
            data-slot="select-scroll-up-arrow"
          >
            <ChevronUpIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollUpArrow>
          {/* The one popup sheet (index.css popup-surface), the same as menus. */}
          <div className="popup-surface relative h-full min-w-(--anchor-width) rounded-lg">
            <SelectPrimitive.List
              className={cn(
                "max-h-(--available-height) overflow-y-auto p-1",
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
            <ChevronDownIcon className="relative size-4.5 sm:size-4" />
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
 */
export function SelectItem({
  className,
  children,
  meta,
  ...props
}: SelectPrimitive.Item.Props & { meta?: React.ReactNode }): React.ReactElement {
  return (
    <SelectPrimitive.Item
      className={cn(POPUP_ROW_CLASS, POPUP_CHECK_ROW_CLASS, className)}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 items-center gap-2.5 [&_svg:not([class*='text-'])]:text-muted-foreground">
        {children}
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
        "not-in-data-[slot=field]:mb-2 inline-flex cursor-default items-center gap-2 font-medium text-base/4.5 text-foreground sm:text-sm/4",
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

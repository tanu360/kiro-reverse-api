"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { mergeProps } from "@base-ui/react/merge-props";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckIcon, ChevronRightIcon, XIcon } from "@hugeicons/core-free-icons";
import type React from "react";
import { createContext, useContext } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OVERLAY_CLOSE_CLASS } from "@/components/ui/dialog";
import { wrapTabFocus } from "@/components/ui/modal-focus";
import {
  POPUP_BUTTON_ROW_CLASS,
  POPUP_GROUP_LABEL_CLASS,
  POPUP_SEPARATOR_CLASS,
  POPUP_SWITCH_THUMB_CLASS,
  POPUP_SWITCH_TRACK_CLASS,
} from "@/components/ui/popup-row";
import { ScrollArea } from "@/components/ui/scroll-area";

type DrawerPosition = "right" | "left" | "top" | "bottom";

const DrawerContext: React.Context<{ position: DrawerPosition }> =
  createContext<{ position: DrawerPosition }>({
    position: "bottom",
  });

const directionMap: Record<
  DrawerPosition,
  DrawerPrimitive.Root.Props["swipeDirection"]
> = {
  bottom: "down",
  left: "left",
  right: "right",
  top: "up",
};

export const DrawerCreateHandle: typeof DrawerPrimitive.createHandle =
  DrawerPrimitive.createHandle;

export function Drawer({
  swipeDirection,
  position = "bottom",
  ...props
}: DrawerPrimitive.Root.Props & {
  position?: DrawerPosition;
}): React.ReactElement {
  return (
    <DrawerContext.Provider value={{ position }}>
      <DrawerPrimitive.Root
        swipeDirection={swipeDirection ?? directionMap[position]}
        {...props}
      />
    </DrawerContext.Provider>
  );
}

export const DrawerPortal: typeof DrawerPrimitive.Portal =
  DrawerPrimitive.Portal;

export function DrawerTrigger(
  props: DrawerPrimitive.Trigger.Props,
): React.ReactElement {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

export function DrawerClose(
  props: DrawerPrimitive.Close.Props,
): React.ReactElement {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

export function DrawerSwipeArea({
  className,
  position: positionProp,
  ...props
}: DrawerPrimitive.SwipeArea.Props & {
  position?: DrawerPosition;
}): React.ReactElement {
  const { position: contextPosition } = useContext(DrawerContext);
  const position = positionProp ?? contextPosition;

  return (
    <DrawerPrimitive.SwipeArea
      className={cn(
        "fixed z-50 touch-none",
        position === "bottom" && "inset-x-0 bottom-0 h-8",
        position === "top" && "inset-x-0 top-0 h-8",
        position === "left" && "inset-y-0 left-0 w-8",
        position === "right" && "inset-y-0 right-0 w-8",
        className,
      )}
      data-slot="drawer-swipe-area"
      {...props}
    />
  );
}

export function DrawerBackdrop({
  className,
  ...props
}: DrawerPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-swiping:duration-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="drawer-backdrop"
      {...props}
    />
  );
}

export function DrawerViewport({
  className,
  position,
  variant = "default",
  ...props
}: DrawerPrimitive.Viewport.Props & {
  position?: DrawerPosition;
  variant?: "default" | "straight" | "inset";
}): React.ReactElement {
  return (
    <DrawerPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 [--bleed:--spacing(12)] [--inset:0px]",
        "touch-none",
        position === "bottom" &&
          "grid grid-rows-[1fr_auto] pt-[max(--spacing(2),env(safe-area-inset-top,0px))]",
        position === "top" && "grid grid-rows-[auto_1fr] pb-12",
        position === "left" && "flex justify-start",
        position === "right" && "flex justify-end",
        variant === "inset" && "px-(--inset) sm:[--inset:--spacing(4)]",
        variant === "inset" && position !== "bottom" && "pt-(--inset)",
        variant === "inset" && position !== "top" && "pb-(--inset)",
        className,
      )}
      data-slot="drawer-viewport"
      {...props}
    />
  );
}

export function DrawerPopup({
  className,
  children,
  showCloseButton = false,
  position: positionProp,
  variant = "default",
  showBar = false,
  portalProps,
  onKeyDown,
  ...props
}: DrawerPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  position?: DrawerPosition;
  variant?: "default" | "straight" | "inset";
  showBar?: boolean;
  portalProps?: DrawerPrimitive.Portal.Props;
}): React.ReactElement {
  const { t } = useT();
  const { position: contextPosition } = useContext(DrawerContext);
  const position = positionProp ?? contextPosition;

  const popup = (
    <DrawerPortal {...portalProps}>
      <DrawerBackdrop />
      <DrawerViewport position={position} variant={variant}>
        <DrawerPrimitive.Popup
          className={cn(
            "dialog-glass relative flex max-h-full min-h-0 w-full min-w-0 flex-col text-popover-foreground outline-none transition-[transform,box-shadow,height,background-color] duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform [--peek:calc(--spacing(6)-1px)] [--scale-base:calc(max(0,1-(var(--nested-drawers)*var(--stack-step))))] [--scale:clamp(0,calc(var(--scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--shrink:calc(1-var(--scale))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-step:0.05] before:pointer-events-none before:absolute before:inset-0 after:pointer-events-none after:absolute after:bg-[color-mix(in_srgb,var(--background)_var(--glass-opacity),transparent)] data-swiping:select-none data-nested-drawer-open:overflow-hidden data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(2%*(var(--nested-drawers)-var(--stack-progress))))] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] dark:data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(6%*(var(--nested-drawers)-var(--stack-progress))))]",
            "touch-none",
            position === "bottom" &&
              "transform-[translateY(calc(var(--keyboard-snap-offset)+var(--drawer-swipe-movement-y)))] data-ending-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] data-starting-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] row-start-2 -mb-[max(0px,calc(var(--keyboard-snap-offset)+clamp(0,1,var(--keyboard-snap-offset)/1px)*var(--drawer-swipe-movement-y,0px)))] border-t pb-[max(0px,calc(max(env(safe-area-inset-bottom,0px),var(--drawer-keyboard-inset,0px))+var(--keyboard-snap-offset)+clamp(0,1,var(--keyboard-snap-offset)/1px)*var(--drawer-swipe-movement-y,0px)))] not-data-starting-style:not-data-ending-style:transition-[transform,box-shadow,height,background-color,margin,padding] [--keyboard-snap-offset:max(0px,calc(var(--drawer-snap-point-offset,0px)-var(--drawer-keyboard-inset,0px)))] after:inset-x-0 after:top-full after:h-(--bleed) has-data-[slot=drawer-bar]:pt-2 data-ending-style:mb-0 data-starting-style:mb-0 data-ending-style:pb-0 data-starting-style:pb-0",
            position === "top" &&
              "data-starting-style:transform-[translateY(calc(-100%-var(--inset)))] data-ending-style:transform-[translateY(calc(-100%-var(--inset)))] transform-[translateY(var(--drawer-swipe-movement-y))] border-b after:inset-x-0 after:bottom-full after:h-(--bleed) has-data-[slot=drawer-bar]:pb-2",
            position === "left" &&
              "data-starting-style:transform-[translateX(calc(-100%-var(--inset)))] data-ending-style:transform-[translateX(calc(-100%-var(--inset)))] transform-[translateX(var(--drawer-swipe-movement-x))] w-[calc(100%-(--spacing(12)))] max-w-md border-e after:inset-y-0 after:end-full after:w-(--bleed) has-data-[slot=drawer-bar]:pe-2",
            position === "right" &&
              "transform-[translateX(var(--drawer-swipe-movement-x))] data-ending-style:transform-[translateX(calc(100%+var(--inset)))] data-starting-style:transform-[translateX(calc(100%+var(--inset)))] col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s after:inset-y-0 after:start-full after:w-(--bleed) has-data-[slot=drawer-bar]:ps-2",
            variant !== "straight" &&
              cn(
                position === "bottom" && "rounded-t-2xl",
                position === "top" &&
                  "rounded-b-2xl **:data-[slot=drawer-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
                position === "left" &&
                  "rounded-e-2xl **:data-[slot=drawer-footer]:rounded-ee-[calc(var(--radius-2xl)-1px)]",
                position === "right" &&
                  "rounded-s-2xl **:data-[slot=drawer-footer]:rounded-es-[calc(var(--radius-2xl)-1px)]",
              ),
            variant === "default" &&
              cn(
                position === "bottom" &&
                  "before:rounded-t-[calc(var(--radius-2xl)-1px)]",
                position === "top" &&
                  "before:rounded-b-[calc(var(--radius-2xl)-1px)]",
                position === "left" &&
                  "before:rounded-e-[calc(var(--radius-2xl)-1px)]",
                position === "right" &&
                  "before:rounded-s-[calc(var(--radius-2xl)-1px)]",
              ),
            variant === "inset" &&
              "before:hidden sm:rounded-2xl sm:border sm:after:bg-transparent sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=drawer-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            variant === "straight" && "[--stack-step:0]",
            (position === "bottom" || position === "top") &&
              "h-(--drawer-height,auto) [--height:max(0px,calc(var(--drawer-frontmost-height,var(--drawer-height))))] data-nested-drawer-open:h-(--height)",
            position === "bottom" &&
              "data-nested-drawer-open:transform-[translateY(calc(var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-(var(--shrink)*var(--height))))_scale(var(--scale))] origin-[50%_calc(100%-var(--inset))]",
            position === "top" &&
              "data-nested-drawer-open:transform-[translateY(calc(var(--drawer-swipe-movement-y)+var(--stack-peek-offset)+(var(--shrink)*var(--height))))_scale(var(--scale))] origin-[50%_var(--inset)]",
            position === "left" &&
              "data-nested-drawer-open:transform-[translateX(calc(var(--drawer-swipe-movement-x)+var(--stack-peek-offset)))_scale(var(--scale))] origin-right",
            position === "right" &&
              "data-nested-drawer-open:transform-[translateX(calc(var(--drawer-swipe-movement-x)-var(--stack-peek-offset)))_scale(var(--scale))] origin-left",
            className,
          )}
          data-slot="drawer-popup"
          onKeyDown={(event) => {
            onKeyDown?.(event);
            wrapTabFocus(event);
          }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DrawerPrimitive.Close
              aria-label={t("actions.close")}
              className={OVERLAY_CLOSE_CLASS}
              data-slot="drawer-dismiss"
              render={<Button size="icon" variant="ghost" />}
            >
              <HugeiconsIcon icon={XIcon} />
            </DrawerPrimitive.Close>
          )}
          {showBar && <DrawerBar />}
        </DrawerPrimitive.Popup>
      </DrawerViewport>
    </DrawerPortal>
  );

  return position === "bottom" ? (
    <DrawerPrimitive.VirtualKeyboardProvider>
      {popup}
    </DrawerPrimitive.VirtualKeyboardProvider>
  ) : (
    popup
  );
}

export function DrawerHeader({
  className,
  allowSelection = false,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  allowSelection?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "flex flex-col gap-2 p-6 max-sm:px-4 max-sm:pb-4 in-[[data-slot=drawer-popup]:has([data-slot=drawer-panel])]:pb-3 in-[[data-slot=drawer-popup]:has(>[data-slot=drawer-dismiss])]:pe-14",
      !allowSelection && "cursor-default",
      className,
    ),
    "data-slot": "drawer-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render: allowSelection ? <DrawerContent render={render} /> : render,
  });
}

export function DrawerFooter({
  className,
  variant = "default",
  allowSelection = true,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  variant?: "default" | "bare";
  allowSelection?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      // Phones: Cancel and the main action share one row of two (dialog.tsx DialogFooter).
      "grid grid-cols-2 gap-2 px-6 pb-(--safe-area-inset-bottom,0px) max-sm:px-4 max-sm:[&>:last-child:nth-child(odd)]:col-span-2 sm:flex sm:flex-row sm:justify-end",
      !allowSelection && "cursor-default",
      variant === "default" &&
        "border-t border-border-subtle bg-surface-inset pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+--spacing(4))]",
      variant === "bare" &&
        "in-[[data-slot=drawer-popup]:has([data-slot=drawer-panel])]:pt-3 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+--spacing(6))]",
      className,
    ),
    "data-slot": "drawer-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render: allowSelection ? <DrawerContent render={render} /> : render,
  });
}

export function DrawerTitle({
  className,
  ...props
}: DrawerPrimitive.Title.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Title
      className={cn("wrap-anywhere font-semibold text-subtitle", className)}
      data-slot="drawer-title"
      {...props}
    />
  );
}

export function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Description
      className={cn("text-pretty text-muted-foreground text-sm leading-relaxed", className)}
      data-slot="drawer-description"
      {...props}
    />
  );
}

export function DrawerPanel({
  className,
  scrollFade = true,
  scrollable = true,
  allowSelection = true,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  scrollFade?: boolean;
  scrollable?: boolean;
  allowSelection?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "p-6 max-sm:px-4 in-[[data-slot=drawer-popup]:has([data-slot=drawer-header])]:pt-1 in-[[data-slot=drawer-popup]:has([data-slot=drawer-footer]:not(.border-t))]:pb-1",
      !allowSelection && "cursor-default",
      className,
    ),
    "data-slot": "drawer-panel",
  };

  const content = useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render: allowSelection ? <DrawerContent render={render} /> : render,
  });

  if (scrollable) {
    // The popup reserves keyboard space; extra viewport padding would overflow the panel.
    return (
      <ScrollArea
        className="touch-auto *:data-[slot=scroll-area-viewport]:pb-0!"
        overscrollContain
        scrollFade={scrollFade}
      >
        {content}
      </ScrollArea>
    );
  }

  return content;
}

export function DrawerBar({
  className,
  position: positionProp,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  position?: DrawerPosition;
}): React.ReactElement {
  const { position: contextPosition } = useContext(DrawerContext);
  const position = positionProp ?? contextPosition;
  const horizontal = position === "left" || position === "right";
  const defaultProps = {
    "aria-hidden": true as const,
    className: cn(
      "absolute flex touch-none items-center justify-center p-3 before:rounded-full before:bg-input",
      horizontal
        ? "inset-y-0 before:h-12 before:w-1"
        : "inset-x-0 before:h-1 before:w-12",
      position === "top" && "bottom-0",
      position === "bottom" && "top-0",
      position === "left" && "right-0",
      position === "right" && "left-0",
      className,
    ),
    "data-slot": "drawer-bar",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export const DrawerContent: typeof DrawerPrimitive.Content =
  DrawerPrimitive.Content;

export function DrawerMenu({
  className,
  render,
  ...props
}: useRender.ComponentProps<"nav">): React.ReactElement {
  const defaultProps = {
    className: cn("-m-2 flex flex-col", className),
    "data-slot": "drawer-menu",
  };

  return useRender({
    defaultTagName: "nav",
    props: mergeProps<"nav">(defaultProps, props),
    render,
  });
}

export function DrawerMenuItem({
  className,
  variant = "default",
  render,
  disabled,
  ...props
}: useRender.ComponentProps<"button"> & {
  variant?: "default" | "destructive";
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      // The popup row (popup-row.tsx) as a button; icons muted, as menu action rows.
      POPUP_BUTTON_ROW_CLASS,
      "data-[variant=destructive]:text-destructive-foreground [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current",
      className,
    ),
    "data-slot": "drawer-menu-item",
    "data-variant": variant,
    disabled,
    type: "button" as const,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function DrawerMenuSeparator({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(POPUP_SEPARATOR_CLASS, className),
    "data-slot": "drawer-menu-separator",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function DrawerMenuGroup({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn("flex flex-col", className),
    "data-slot": "drawer-menu-group",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function DrawerMenuGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(POPUP_GROUP_LABEL_CLASS, className),
    "data-slot": "drawer-menu-group-label",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function DrawerMenuTrigger({
  className,
  children,
  ...props
}: DrawerPrimitive.Trigger.Props): React.ReactElement {
  return (
    <DrawerTrigger
      className={cn(
        POPUP_BUTTON_ROW_CLASS,
        "[&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-slot="drawer-menu-trigger"
      {...props}
    >
      {children}
      <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" className="-me-1 ms-auto" />
    </DrawerTrigger>
  );
}

export function DrawerMenuCheckboxItem({
  className,
  children,
  checked,
  defaultChecked,
  onCheckedChange,
  variant = "default",
  disabled,
  render,
  ...props
}: CheckboxPrimitive.Root.Props & {
  variant?: "default" | "switch";
  render?: React.ReactElement;
}): React.ReactElement {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      className={cn(
        POPUP_BUTTON_ROW_CLASS,
        "grid",
        variant === "switch"
          ? "grid-cols-[minmax(0,1fr)_auto] gap-4 pe-1.5 data-checked:text-foreground"
          : "grid-cols-[1rem_minmax(0,1fr)] pe-4",
        className,
      )}
      data-slot="drawer-menu-checkbox-item"
      defaultChecked={defaultChecked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      render={render}
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="wrap-anywhere col-start-1 min-w-0">{children}</span>
          <CheckboxPrimitive.Indicator
            className={cn("col-start-2", POPUP_SWITCH_TRACK_CLASS)}
            keepMounted
          >
            <span className={POPUP_SWITCH_THUMB_CLASS} />
          </CheckboxPrimitive.Indicator>
        </>
      ) : (
        <>
          <CheckboxPrimitive.Indicator className="col-start-1">
            <HugeiconsIcon aria-hidden="true" icon={CheckIcon} />
          </CheckboxPrimitive.Indicator>
          <span className="wrap-anywhere col-start-2 min-w-0">{children}</span>
        </>
      )}
    </CheckboxPrimitive.Root>
  );
}

export function DrawerMenuRadioGroup({
  className,
  ...props
}: RadioGroupPrimitive.Props): React.ReactElement {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col", className)}
      data-slot="drawer-menu-radio-group"
      {...props}
    />
  );
}

export function DrawerMenuRadioItem({
  className,
  children,
  value,
  disabled,
  render,
  ...props
}: RadioPrimitive.Root.Props & {
  value: string;
  render?: React.ReactElement;
}): React.ReactElement {
  return (
    <RadioPrimitive.Root
      className={cn(
        POPUP_BUTTON_ROW_CLASS,
        "grid grid-cols-[1rem_minmax(0,1fr)] pe-4",
        className,
      )}
      data-slot="drawer-menu-radio-item"
      disabled={disabled}
      render={render}
      value={value}
      {...props}
    >
      <RadioPrimitive.Indicator className="col-start-1">
        <HugeiconsIcon aria-hidden="true" icon={CheckIcon} />
      </RadioPrimitive.Indicator>
      <span className="wrap-anywhere col-start-2 min-w-0">{children}</span>
    </RadioPrimitive.Root>
  );
}

export { DrawerPrimitive };

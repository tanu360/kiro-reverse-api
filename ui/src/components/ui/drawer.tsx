"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type React from "react";
import { createContext, useCallback, useContext } from "react";
import { Button } from "@/components/ui/button";
import { OVERLAY_CLOSE_CLASS } from "@/components/ui/dialog";
import { wrapTabFocus } from "@/components/ui/modal-focus";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type DrawerPosition = "right" | "left" | "top" | "bottom";

const DrawerContext: React.Context<{ position: DrawerPosition }> = createContext<{
  position: DrawerPosition;
}>({
  position: "bottom",
});

const directionMap: Record<DrawerPosition, DrawerPrimitive.Root.Props["swipeDirection"]> = {
  bottom: "down",
  left: "left",
  right: "right",
  top: "up",
};

export function Drawer({
  swipeDirection,
  position = "bottom",
  ...props
}: DrawerPrimitive.Root.Props & {
  position?: DrawerPosition;
}): React.ReactElement {
  return (
    <DrawerContext.Provider value={{ position }}>
      <DrawerPrimitive.Root swipeDirection={swipeDirection ?? directionMap[position]} {...props} />
    </DrawerContext.Provider>
  );
}

const DrawerPortal: typeof DrawerPrimitive.Portal = DrawerPrimitive.Portal;

function DrawerBackdrop({
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

function DrawerViewport({
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
        // Phones (below sm): a bottom drawer floats, 5vw (the modal gap, index.css) clear of the
        // sides and the same under it, plus the home-indicator inset. --inset also sets how far
        // it slides to leave.
        position === "bottom" &&
          "max-sm:px-(--inset) max-sm:pb-[calc(var(--inset)+env(safe-area-inset-bottom,0px))] max-sm:[--inset:var(--modal-gap-x)]",
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

/** The drawer's slide: the same 450 ms curve as its CSS transitions. */
const DRAWER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const DRAWER_DURATION_MS = 450;

/**
 * A top or bottom drawer is as tall as its content (height auto, up to the screen), and CSS
 * cannot transition from one auto height to another (interpolate-size only covers a change of
 * the height value, not of the content), so a step flow's sheet jumped to its new height in one
 * frame. This watches the popup and, when its content makes it taller or shorter, plays the
 * change as a height animation on the drawer's own curve, so the top edge glides. A change of
 * padding alone (the on-screen keyboard's inset, which has its own transition) only updates the
 * baseline. It stays out of the open and close slides, a swipe, a parent with a nested drawer
 * open (Base UI sizes that one itself) and reduced motion. Returns the cleanup.
 */
function animateContentHeight(popup: HTMLElement): () => void {
  if (typeof ResizeObserver !== "function" || typeof popup.animate !== "function") {
    return () => {};
  }
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let borderHeight = 0;
  let contentHeight = 0;
  let running: Animation | null = null;
  const observer = new ResizeObserver(([entry]) => {
    // While an animation runs, the sizes reported are its own frames.
    if (!entry || running) return;
    const nextBorder = entry.borderBoxSize?.[0]?.blockSize ?? popup.offsetHeight;
    const nextContent = entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
    const from = borderHeight;
    const contentChanged = Math.abs(nextContent - contentHeight) >= 1;
    borderHeight = nextBorder;
    contentHeight = nextContent;
    if (!from || !contentChanged || Math.abs(nextBorder - from) < 2) return;
    if (
      reducedMotion?.matches ||
      popup.matches(
        "[data-starting-style],[data-ending-style],[data-swiping],[data-nested-drawer-open]",
      )
    ) {
      return;
    }
    const animation = popup.animate([{ height: `${from}px` }, { height: `${nextBorder}px` }], {
      duration: DRAWER_DURATION_MS,
      easing: DRAWER_EASING,
    });
    running = animation;
    const settle = (): void => {
      if (running === animation) running = null;
    };
    animation.addEventListener("finish", settle);
    animation.addEventListener("cancel", settle);
  });
  observer.observe(popup, { box: "border-box" });
  return () => {
    observer.disconnect();
    running?.cancel();
  };
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
  ref,
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
  const vertical = position === "bottom" || position === "top";

  // The caller's ref plus, on a top or bottom drawer, the content-height animation (a ref
  // callback's cleanup ends it when the popup unmounts).
  const popupRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
      const stop = node && vertical ? animateContentHeight(node) : undefined;
      return () => {
        stop?.();
        if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref, vertical],
  );

  const popup = (
    <DrawerPortal {...portalProps}>
      {/*
        forceRender: a drawer opened from inside another drawer or a sheet (Base UI nesting)
        draws its own backdrop too, so the parent dims behind it, as DialogPopup does.
      */}
      <DrawerBackdrop forceRender />
      <DrawerViewport position={position} variant={variant}>
        <DrawerPrimitive.Popup
          className={cn(
            "dialog-glass relative flex max-h-full min-h-0 w-full min-w-0 flex-col text-popover-foreground outline-none transition-[transform,box-shadow,height,background-color] duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform [--peek:calc(--spacing(6)-1px)] [--scale-base:calc(max(0,1-(var(--nested-drawers)*var(--stack-step))))] [--scale:clamp(0,calc(var(--scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--shrink:calc(1-var(--scale))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-step:0.05] before:pointer-events-none before:absolute before:inset-0 after:pointer-events-none after:absolute after:bg-[color-mix(in_srgb,var(--background)_var(--glass-opacity),transparent)] data-swiping:select-none data-nested-drawer-open:overflow-hidden data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(2%*(var(--nested-drawers)-var(--stack-progress))))] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] dark:data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(6%*(var(--nested-drawers)-var(--stack-progress))))]",
            "touch-none",
            position === "bottom" &&
              "transform-[translateY(calc(var(--keyboard-snap-offset)+var(--drawer-swipe-movement-y)))] data-ending-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] data-starting-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] row-start-2 -mb-[max(0px,calc(var(--keyboard-snap-offset)+clamp(0,1,var(--keyboard-snap-offset)/1px)*var(--drawer-swipe-movement-y,0px)))] border-t pb-[max(0px,calc(max(var(--drawer-safe-bottom),var(--drawer-keyboard-inset,0px))+var(--keyboard-snap-offset)+clamp(0,1,var(--keyboard-snap-offset)/1px)*var(--drawer-swipe-movement-y,0px)))] not-data-starting-style:not-data-ending-style:transition-[transform,box-shadow,height,background-color,margin,padding] [--keyboard-snap-offset:max(0px,calc(var(--drawer-snap-point-offset,0px)-var(--drawer-keyboard-inset,0px)))] after:inset-x-0 after:top-full after:h-(--bleed) has-data-[slot=drawer-bar]:pt-2 data-ending-style:mb-0 data-starting-style:mb-0 data-ending-style:pb-0 data-starting-style:pb-0",
            position === "top" &&
              "data-starting-style:transform-[translateY(calc(-100%-var(--inset)))] data-ending-style:transform-[translateY(calc(-100%-var(--inset)))] transform-[translateY(var(--drawer-swipe-movement-y))] border-b after:inset-x-0 after:bottom-full after:h-(--bleed) has-data-[slot=drawer-bar]:pb-2",
            position === "left" &&
              "data-starting-style:transform-[translateX(calc(-100%-var(--inset)))] data-ending-style:transform-[translateX(calc(-100%-var(--inset)))] transform-[translateX(var(--drawer-swipe-movement-x))] w-[calc(100%-(--spacing(12)))] max-w-md border-e after:inset-y-0 after:inset-e-full after:w-(--bleed) has-data-[slot=drawer-bar]:pe-2",
            position === "right" &&
              "transform-[translateX(var(--drawer-swipe-movement-x))] data-ending-style:transform-[translateX(calc(100%+var(--inset)))] data-starting-style:transform-[translateX(calc(100%+var(--inset)))] col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s after:inset-y-0 after:inset-s-full after:w-(--bleed) has-data-[slot=drawer-bar]:ps-2",
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
                position === "bottom" && "before:rounded-t-[calc(var(--radius-2xl)-1px)]",
                position === "top" && "before:rounded-b-[calc(var(--radius-2xl)-1px)]",
                position === "left" && "before:rounded-e-[calc(var(--radius-2xl)-1px)]",
                position === "right" && "before:rounded-s-[calc(var(--radius-2xl)-1px)]",
              ),
            variant === "inset" &&
              "before:hidden sm:rounded-2xl sm:border sm:after:bg-transparent sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=drawer-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            variant === "straight" && "[--stack-step:0]",
            (position === "bottom" || position === "top") &&
              "h-(--drawer-height,auto) [--height:max(0px,calc(var(--drawer-frontmost-height,var(--drawer-height))))] data-nested-drawer-open:h-(--height)",
            // Phones: the floating panel (DrawerViewport) has four rounded corners and a full
            // border, no bleed under it, at most 90dvh tall, and leaves the home-indicator inset
            // to the viewport (--drawer-safe-bottom, which the footer reads too).
            position === "bottom" &&
              "[--drawer-safe-bottom:env(safe-area-inset-bottom,0px)] max-sm:max-h-[calc(100dvh-var(--modal-gap-y)*2)] max-sm:rounded-2xl max-sm:border max-sm:[--drawer-safe-bottom:0px] max-sm:before:rounded-[calc(var(--radius-2xl)-1px)] max-sm:after:hidden max-sm:**:data-[slot=drawer-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
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
          ref={popupRef}
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
    <DrawerPrimitive.VirtualKeyboardProvider>{popup}</DrawerPrimitive.VirtualKeyboardProvider>
  ) : (
    popup
  );
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

function DrawerBar({
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
      horizontal ? "inset-y-0 before:h-12 before:w-1" : "inset-x-0 before:h-1 before:w-12",
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

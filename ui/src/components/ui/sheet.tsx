"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { XIcon } from "@hugeicons/core-free-icons";
import type React from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OVERLAY_CLOSE_CLASS } from "@/components/ui/dialog";
import { wrapTabFocus } from "@/components/ui/modal-focus";
import { ScrollArea } from "@/components/ui/scroll-area";

export const Sheet: typeof SheetPrimitive.Root = SheetPrimitive.Root;

export const SheetPortal: typeof SheetPrimitive.Portal = SheetPrimitive.Portal;

export function SheetTrigger(
  props: SheetPrimitive.Trigger.Props,
): React.ReactElement {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(
  props: SheetPrimitive.Close.Props,
): React.ReactElement {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export function SheetBackdrop({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <SheetPrimitive.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="sheet-backdrop"
      {...props}
    />
  );
}

export function SheetViewport({
  className,
  side,
  variant = "default",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
}): React.ReactElement {
  return (
    <SheetPrimitive.Viewport
      className={cn(
        // Phones (below sm): every sheet is an inset floating panel, at most 90vw by 90dvh (the
        // modal gaps in index.css). A side sheet keeps its side; a top or bottom one is centred.
        "fixed inset-0 z-50 grid max-sm:px-(--modal-gap-x) max-sm:py-(--modal-gap-y)",
        side === "bottom" && "grid grid-rows-[1fr_auto] pt-12",
        side === "top" && "grid grid-rows-[auto_1fr] pb-12",
        (side === "bottom" || side === "top") && "max-sm:grid-rows-[1fr_auto_1fr]",
        side === "left" && "flex justify-start",
        side === "right" && "flex justify-end",
        variant === "inset" && "sm:p-4",
        className,
      )}
      data-slot="sheet-viewport"
      {...props}
    />
  );
}

export function SheetPopup({
  className,
  children,
  showCloseButton = true,
  side = "right",
  variant = "default",
  closeProps,
  portalProps,
  onKeyDown,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
  closeProps?: SheetPrimitive.Close.Props;
  portalProps?: SheetPrimitive.Portal.Props;
}): React.ReactElement {
  const { t } = useT();
  return (
    <SheetPortal {...portalProps}>
      <SheetBackdrop />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitive.Popup
          className={cn(
            // The frosted modal surface (index.css dialog-glass), as dialogs and drawers.
            "dialog-glass relative flex max-h-full min-h-0 w-full min-w-0 flex-col text-popover-foreground outline-none transition-[opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-opacity",
            side === "bottom" &&
              "row-start-2 rounded-t-2xl border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8",
            side === "top" &&
              "border-b max-sm:row-start-2 data-ending-style:-translate-y-8 data-starting-style:-translate-y-8",
            side === "left" &&
              "w-[calc(100%-(--spacing(12)))] max-w-md border-e data-ending-style:-translate-x-8 data-starting-style:-translate-x-8",
            side === "right" &&
              "col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-8 data-starting-style:translate-x-8",
            variant === "inset" &&
              "sm:rounded-2xl sm:border sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            "max-sm:rounded-2xl max-sm:border max-sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            className,
          )}
          data-slot="sheet-popup"
          onKeyDown={(event) => {
            onKeyDown?.(event);
            wrapTabFocus(event);
          }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label={t("actions.close")}
              className={OVERLAY_CLOSE_CLASS}
              data-slot="sheet-dismiss"
              render={<Button size="icon" variant="ghost" />}
              {...closeProps}
            >
              <HugeiconsIcon icon={XIcon} />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

export function SheetHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(
      // 24 px round (16 px at the sides on phones), 12 px above a panel at every width. Once the
      // panel scrolls, a hairline under the header marks where the content runs beneath it.
      "flex flex-col gap-2 border-transparent border-b p-6 transition-colors max-sm:px-4 max-sm:pb-4 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 in-[[data-slot=sheet-popup]:has([data-slot=scroll-area-content][data-overflow-y-start]>[data-slot=sheet-panel])]:border-border-subtle in-[[data-slot=sheet-popup]:has(>[data-slot=sheet-dismiss])]:pe-14",
      className,
    ),
    "data-slot": "sheet-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function SheetFooter({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  /** `split`: the default bar with its content spread to both ends (a status, then actions). */
  variant?: "default" | "bare" | "split";
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "flex gap-2 px-6 max-sm:px-4",
      variant === "split"
        ? "flex-row items-center justify-between"
        : "flex-col-reverse sm:flex-row sm:justify-end",
      variant !== "bare" && "border-t border-border-subtle bg-surface-inset py-4",
      variant === "bare" &&
        "in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pt-3 pt-4 pb-6",
      className,
    ),
    "data-slot": "sheet-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props): React.ReactElement {
  return (
    <SheetPrimitive.Title
      className={cn("wrap-anywhere font-semibold text-subtitle", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props): React.ReactElement {
  return (
    <SheetPrimitive.Description
      className={cn("text-pretty text-muted-foreground text-sm leading-relaxed", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export function SheetPanel({
  className,
  scrollFade = true,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  scrollFade?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "p-6 max-sm:px-4 in-[[data-slot=sheet-popup]:has([data-slot=sheet-header])]:pt-1 in-[[data-slot=sheet-popup]:has([data-slot=sheet-footer]:not(.border-t))]:pb-1",
      className,
    ),
    "data-slot": "sheet-panel",
  };

  return (
    <ScrollArea overscrollContain scrollFade={scrollFade}>
      {useRender({
        defaultTagName: "div",
        props: mergeProps<"div">(defaultProps, props),
        render,
      })}
    </ScrollArea>
  );
}

export {
  SheetPrimitive,
  SheetBackdrop as SheetOverlay,
  SheetPopup as SheetContent,
};

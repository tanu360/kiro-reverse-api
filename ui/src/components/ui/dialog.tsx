"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { wrapTabFocus } from "@/components/ui/modal-focus";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Dialog: typeof DialogPrimitive.Root = DialogPrimitive.Root;

const DialogPortal: typeof DialogPrimitive.Portal = DialogPrimitive.Portal;

export function DialogClose(props: DialogPrimitive.Close.Props): React.ReactElement {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

/**
 * Dialog widths, named after the Tailwind max-w step they use (sm 384, md 448, lg 512, xl 576,
 * 2xl 672, 3xl 768 px). ResponsiveDialog takes the same names, so `size="xl"` is 576 px
 * everywhere. 3xl is for a dialog with a side rail (add account).
 */
export type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const DIALOG_SIZE_CLASS: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
};

/**
 * Where the popup rests: `center` in the middle of the screen, `top` hung a fixed distance below
 * the top from sm up (at least 48 px, 8 % of the screen), so a dialog whose height changes (a
 * wizard, a log that fills) keeps its title in place. On phones a `top` dialog instead fills the
 * whole 90dvh box, 5dvh above and below like every other modal: the title stays put as steps
 * change height and the gaps stay even (a short step leaves room above its footer).
 */
export type DialogAnchor = "center" | "top";

function DialogViewport({
  className,
  anchor = "center",
  ...props
}: DialogPrimitive.Viewport.Props & { anchor?: DialogAnchor }): React.ReactElement {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        // Phones (below sm): a floating panel, centred, at most 90vw by 90dvh (the modal gaps
        // in index.css), with its four rounded corners and full border.
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 max-sm:px-(--modal-gap-x) max-sm:py-(--modal-gap-y)",
        // Top-anchored (the tall pickers): a 6dvh lead, at least 48 px, so an eight-row list
        // still fits a 768 px laptop screen. On phones it fills the 90dvh box (DialogPopup).
        anchor === "top" &&
          "max-sm:grid-rows-[0_1fr_0] sm:grid-rows-[minmax(--spacing(12),6dvh)_auto_1fr]",
        className,
      )}
      data-anchor={anchor}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

/**
 * The close X: a ghost icon button in the top corner, its centre on the title's line (the header
 * is padded 24 px and the 18 px title is 25 px tall, so the line's centre sits 36 px down).
 */
export const OVERLAY_CLOSE_CLASS = "absolute inset-e-4 top-4.5 z-1 sm:top-5";

export function DialogPopup({
  className,
  children,
  showCloseButton = true,
  size = "lg",
  anchor = "center",
  closeProps,
  portalProps,
  onKeyDown,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  /** Width (DIALOG_SIZE_CLASS); on phones it is also at most 90vw. */
  size?: DialogSize;
  anchor?: DialogAnchor;
  closeProps?: DialogPrimitive.Close.Props;
  portalProps?: DialogPrimitive.Portal.Props;
}): React.ReactElement {
  const { t } = useT();
  return (
    <DialogPortal {...portalProps}>
      {/*
        forceRender: a dialog opened from inside another dialog or a sheet (Base UI nesting) draws
        its own backdrop too, so the parent dims behind it instead of staying at full brightness.
      */}
      <DialogBackdrop forceRender />
      <DialogViewport anchor={anchor}>
        <DialogPrimitive.Popup
          className={cn(
            // t3code dialog-styles.ts DIALOG_POPUP_CLASS: frosted glass (index.css dialog-glass).
            "dialog-glass relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 translate-y-[calc(-1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-opacity",
            DIALOG_SIZE_CLASS[size],
            // A `top` dialog on phones fills its 90dvh row (the grid stretches it); the footer
            // keeps to the bottom edge when a step is short.
            anchor === "top" && "max-sm:*:data-[slot=dialog-footer]:mt-auto",
            className,
          )}
          data-size={size}
          data-slot="dialog-popup"
          onKeyDown={(event) => {
            onKeyDown?.(event);
            wrapTabFocus(event);
          }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label={t("actions.close")}
              className={OVERLAY_CLOSE_CLASS}
              data-slot="dialog-dismiss"
              render={<Button size="icon" variant="ghost" />}
              {...closeProps}
            >
              <HugeiconsIcon icon={XIcon} />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(
      // 24 px round (16 px at the sides on phones), 12 px above a panel; clear of the close X.
      "flex flex-col gap-2 p-6 max-sm:px-4 max-sm:pb-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 in-[[data-slot=dialog-popup]:has(>[data-slot=dialog-dismiss])]:pe-14",
      className,
    ),
    "data-slot": "dialog-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function DialogFooter({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      // Phones: Cancel and the main action share one row of two; a lone (or odd last) button
      // takes the whole row. From sm up they sit at the end.
      "grid grid-cols-2 gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] px-6 max-sm:px-4 max-sm:[&>:last-child:nth-child(odd)]:col-span-2 sm:flex sm:flex-row sm:justify-end",
      variant === "default" && "border-t border-border-subtle bg-surface-inset py-4",
      variant === "bare" &&
        "in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3 pt-4 pb-6",
      className,
    ),
    "data-slot": "dialog-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props): React.ReactElement {
  return (
    <DialogPrimitive.Title
      className={cn("wrap-anywhere font-semibold text-subtitle", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.ReactElement {
  return (
    <DialogPrimitive.Description
      className={cn("text-pretty text-muted-foreground text-sm leading-relaxed", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export function DialogPanel({
  className,
  scrollFade = true,
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  scrollFade?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "p-6 max-sm:px-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
      className,
    ),
    "data-slot": "dialog-panel",
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

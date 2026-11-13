"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type React from "react";
import { wrapTabFocus } from "@/components/ui/modal-focus";
import { ModalNoticeHost, ModalNoticeOutlet } from "@/components/ui/modal-notice";
import { cn } from "@/lib/utils";

export const AlertDialog: typeof AlertDialogPrimitive.Root = AlertDialogPrimitive.Root;

const AlertDialogPortal: typeof AlertDialogPrimitive.Portal = AlertDialogPrimitive.Portal;

function AlertDialogBackdrop({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

function AlertDialogViewport({
  className,
  ...props
}: AlertDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Viewport
      className={cn(
        // Phones: centred and floating, at most 90vw by 90dvh, as dialogs (dialog.tsx).
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 max-sm:px-(--modal-gap-x) max-sm:py-(--modal-gap-y)",
        className,
      )}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

export function AlertDialogPopup({
  className,
  children,
  portalProps,
  onKeyDown,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  portalProps?: AlertDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <AlertDialogPortal {...portalProps}>
      {/* forceRender: nested in a dialog or sheet, it still dims its parent (dialog.tsx). */}
      <AlertDialogBackdrop forceRender />
      <AlertDialogViewport>
        <AlertDialogPrimitive.Popup
          className={cn(
            "dialog-glass relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg translate-y-[calc(-1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-opacity",
            className,
          )}
          data-slot="alert-dialog-popup"
          onKeyDown={(event) => {
            onKeyDown?.(event);
            wrapTabFocus(event);
          }}
          {...props}
        >
          <ModalNoticeHost>{children}</ModalNoticeHost>
        </AlertDialogPrimitive.Popup>
      </AlertDialogViewport>
    </AlertDialogPortal>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        // Start-aligned at every width, as the dialogs and sheets.
        "flex min-h-0 flex-col gap-2 p-6 text-start max-sm:px-4 max-sm:pb-4",
        className,
      )}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

export function AlertDialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}): React.ReactElement {
  return (
    <>
      {/* An error or warning raised while the dialog is open (modal-notice.tsx). */}
      <ModalNoticeOutlet />
      <div
        className={cn(
          // Phones: Cancel and the action share one row of two (dialog.tsx DialogFooter).
          "grid grid-cols-2 gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] px-6 max-sm:px-4 max-sm:[&>:last-child:nth-child(odd)]:col-span-2 sm:flex sm:flex-row sm:justify-end",
          variant === "default" && "border-t border-border-subtle bg-surface-inset py-4",
          variant === "bare" && "pb-6",
          className,
        )}
        data-slot="alert-dialog-footer"
        {...props}
      />
    </>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      className={cn("wrap-anywhere shrink-0 font-semibold text-subtitle", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-pretty text-muted-foreground text-sm leading-relaxed", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

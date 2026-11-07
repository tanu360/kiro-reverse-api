"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { AutocompleteCollection } from "@/components/ui/autocomplete";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/*
 * Kiro patch: a Raycast-style palette. A 640 px sheet hung under the header trigger (16 px from
 * the top on phones): the one solid popup sheet (index.css popup-surface) with the floating
 * shadow, not glass, so its hairline still shows on the dimmed page in dark mode. A 60 px search
 * row with Esc at its end, 40 px rows with 20 px icons, and a floating foot (the app mark, the
 * Enter verb and the arrow keys) that the list scrolls behind. It opens from 8 px up at 96 % and leaves faster than it came. Placement, sizes and the
 * foot fade live in index.css (command-palette, command-list-fade).
 */

const OPEN_EASE = "ease-[cubic-bezier(0.2,0.8,0.2,1)]";

export const CommandDialog: typeof CommandDialogPrimitive.Root = CommandDialogPrimitive.Root;

const CommandDialogPortal: typeof CommandDialogPrimitive.Portal = CommandDialogPrimitive.Portal;

function CommandDialogBackdrop({
  className,
  ...props
}: CommandDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 transition-opacity duration-220 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:duration-140 data-ending-style:ease-in supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({
  className,
  ...props
}: CommandDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn("fixed inset-0 z-50", className)}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

export function CommandDialogPopup({
  className,
  children,
  portalProps,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  portalProps?: CommandDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <CommandDialogPortal {...portalProps}>
      <CommandDialogBackdrop />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            "popup-surface command-palette flex min-w-0 origin-top flex-col overflow-hidden rounded-2xl text-popover-foreground outline-none [--command-foot:--spacing(14)] pointer-coarse:[--command-foot:--spacing(4)]",
            "transition-[opacity,translate,scale] duration-220 data-ending-style:-translate-y-2 data-starting-style:-translate-y-2 data-ending-style:scale-96 data-starting-style:scale-96 data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:duration-140 data-ending-style:ease-in motion-reduce:transition-opacity",
            OPEN_EASE,
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

export function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: AutocompletePrimitive.Root.Props<unknown>): React.ReactElement {
  return (
    <AutocompletePrimitive.Root
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

/** The 60 px search row: a 20 px glass, the field at 16 px and Esc at the end. */
export function CommandInput({
  className,
  escapeLabel = "Esc",
  ...props
}: AutocompletePrimitive.Input.Props & { escapeLabel?: string }): React.ReactElement {
  return (
    <div
      className="flex h-15 shrink-0 items-center gap-3 px-4 text-muted-foreground"
      data-slot="command-search"
    >
      <HugeiconsIcon icon={Search01Icon} aria-hidden="true" className="size-5 shrink-0" />
      <AutocompletePrimitive.Input
        autoComplete="off"
        autoFocus
        className={cn(
          "h-full w-full min-w-0 bg-transparent p-0 font-medium text-base text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground",
          className,
        )}
        spellCheck={false}
        {...props}
      />
      <Kbd aria-hidden="true" className="min-w-7 shrink-0 pointer-coarse:hidden">
        {escapeLabel}
      </Kbd>
    </div>
  );
}

/**
 * Native scroll, not ScrollArea: rows snap a slot at a time, scroll-padding keeps the highlighted
 * row clear of the foot, and the mask fades rows out behind it.
 */
export function CommandList({
  className,
  ...props
}: AutocompletePrimitive.List.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.List
      className={cn(
        "command-list-fade min-h-0 flex-1 snap-y snap-proximity scroll-pt-8 scroll-pb-(--command-foot) overflow-y-auto overscroll-contain px-2 pb-(--command-foot)",
        className,
      )}
      data-slot="command-list"
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: AutocompletePrimitive.Empty.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.Empty
      className={cn(
        "wrap-anywhere text-center text-meta text-muted-foreground not-empty:px-3 not-empty:py-7",
        className,
      )}
      data-slot="command-empty"
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: AutocompletePrimitive.Group.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.Group
      className={cn("[[role=group]+&]:mt-2", className)}
      data-slot="command-group"
      {...props}
    />
  );
}

/** 32 px tall, so with the 8 px gap above it a title fills one slot. */
export function CommandGroupLabel({
  className,
  ...props
}: AutocompletePrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn("snap-end px-3 font-medium text-muted-foreground text-xs leading-8", className)}
      data-slot="command-group-label"
      {...props}
    />
  );
}

export const CommandCollection = AutocompleteCollection;

/** A 40 px row: 20 px icon, 12 px gap, 14 px label, 8 px corners inside the 8 px list inset; the highlight takes the popup accent. */
export function CommandItem({
  className,
  ...props
}: AutocompletePrimitive.Item.Props): React.ReactElement {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        "flex h-10 cursor-pointer snap-end select-none items-center gap-3 rounded-lg px-3 text-foreground text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-highlighted:[&_svg]:text-foreground",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

/** Muted text at a row's end: "Current", a count. */
export function CommandItemNote({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      className={cn(
        "ms-auto shrink-0 ps-2 text-meta text-muted-foreground tabular-nums",
        className,
      )}
      data-slot="command-item-note"
      {...props}
    />
  );
}

/** The floating foot: pills at both ends over the list's faded tail. Hidden on touch screens. */
export function CommandFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-2 pb-2 pointer-coarse:hidden",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

/** A 40 px frosted pill in the foot. */
export function CommandFooterPill({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      className={cn(
        "pointer-events-auto flex h-10 items-center rounded-full border border-foreground/12 bg-popover/64 shadow-[inset_0_1px_0_rgb(255_255_255/12%)] backdrop-blur-lg backdrop-saturate-160",
        className,
      )}
      data-slot="command-footer-pill"
      {...props}
    />
  );
}

/** One key hint: a word, then its keys. */
export function CommandHint({
  label,
  keys,
  className,
}: {
  label: string;
  keys: string[];
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="me-1">{label}</span>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

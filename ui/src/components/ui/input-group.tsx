"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { Textarea, type TextareaProps } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/*
 * Inline addons. A button inside the field (an eye toggle, a copy or clear button) is pulled
 * toward the edge so its own padding does not double the field's, and its focus ring hugs it
 * (offset 0), so the ring clears the field's border evenly instead of painting over it. An info
 * hint is an icon, not a button box: it keeps the icon inset, which leaves room for its ring.
 */
const inputGroupAddonVariants = cva(
  // The addon's own icons (direct children) take the field's icon size; a button in the addon
  // sizes its icon itself (an xs Upload button keeps its 14 px icon).
  "flex h-auto cursor-text select-none items-center justify-center gap-2 text-muted-foreground leading-none [&>kbd]:rounded-sm in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&>svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&>svg:not([class*='size-'])]:size-4 [&_svg]:-mx-0.5 not-has-[button]:**:[svg:not([class*='opacity-'])]:opacity-80",
  {
    defaultVariants: {
      align: "inline-start",
    },
    variants: {
      align: {
        "block-end":
          "order-last w-full justify-start px-[calc(--spacing(3)-1px)] pb-[calc(--spacing(3)-1px)] [.border-t]:pt-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "block-start":
          "order-first w-full justify-start px-[calc(--spacing(3)-1px)] pt-[calc(--spacing(3)-1px)] [.border-b]:pb-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "inline-end":
          "order-last pe-[calc(--spacing(3)-1px)] has-[>:last-child[data-slot=badge]]:-me-1.5 has-[>button:not([data-slot=info-hint])]:-me-2 has-[>kbd:last-child]:me-[-0.35rem] [[data-size=sm]+&]:pe-[calc(--spacing(2.5)-1px)] [&>button:not([data-slot=info-hint]):focus-visible]:outline-offset-0",
        "inline-start":
          "order-first ps-[calc(--spacing(3)-1px)] has-[>:last-child[data-slot=badge]]:-ms-1.5 has-[>button:not([data-slot=info-hint])]:-ms-2 has-[>kbd:last-child]:ms-[-0.35rem] [[data-size=sm]+&]:ps-[calc(--spacing(2.5)-1px)] [&>button:not([data-slot=info-hint]):focus-visible]:outline-offset-0",
      },
    },
  },
);

/**
 * A field with addons (an icon, a button, a kbd) inside its frame: the input's soft field fill
 * (index.css --field-*), a soft purple border on focus and no ring, as the sign-in password field.
 */
/**
 * A press on an addon's plain area (an icon or a label, not a control inside
 * it) focuses the group's field instead of blurring it.
 */
function focusFieldFromAddon(e: React.MouseEvent<HTMLFieldSetElement>): void {
  const target = e.target as Element;
  const addon = target.closest("[data-slot='input-group-addon']");
  if (!(addon && e.currentTarget.contains(addon))) return;

  const isInteractive = target.closest(
    "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']",
  );
  if (isInteractive) return;
  e.preventDefault();
  const group = e.currentTarget;
  const input = group.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (input && !group.querySelector("input:focus, textarea:focus")) {
    input.focus();
  }
}

export function InputGroup({
  className,
  onMouseDown,
  ...props
}: React.ComponentProps<"fieldset">): React.ReactElement {
  // <fieldset> carries the group role natively.
  return (
    <fieldset
      className={cn(
        "relative inline-flex w-full min-w-0 items-center rounded-lg border text-base text-foreground transition-[background-color,border-color] duration-150 hover:bg-field-hover has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[textarea]:h-auto has-data-[align=block-end]:h-auto has-data-[align=block-start]:h-auto has-data-[align=block-end]:flex-col has-data-[align=block-start]:flex-col has-[input:focus-visible,textarea:focus-visible,[role=textbox]:focus-visible]:border-field-border-focus has-[input:focus-visible,textarea:focus-visible,[role=textbox]:focus-visible]:bg-field-focus has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-autofill:bg-foreground/4 has-[input:disabled,textarea:disabled]:opacity-64 sm:text-sm dark:has-autofill:bg-foreground/8 has-data-[align=inline-start]:**:[[data-size=sm]_input]:ps-1.5 has-data-[align=inline-end]:**:[[data-size=sm]_input]:pe-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden has-[[data-align=block-start],[data-align=block-end]]:**:[input]:h-auto has-data-[align=inline-start]:**:[input]:ps-2 has-data-[align=inline-end]:**:[input]:pe-2 has-data-[align=block-end]:**:[input]:pt-1.5 has-data-[align=block-start]:**:[input]:pb-1.5 **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5 **:[textarea_button]:rounded-[calc(var(--radius-lg)-1px)] border-field-border bg-field",
        className,
      )}
      data-slot="input-group"
      onMouseDown={(e) => {
        focusFieldFromAddon(e);
        onMouseDown?.(e);
      }}
      {...props}
    />
  );
}

export function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>): React.ReactElement {
  return (
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      {...props}
    />
  );
}

export function InputGroupText({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      className={cn(
        "flex items-center gap-2 truncate text-muted-foreground in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupInput({ className, ...props }: InputProps): React.ReactElement {
  return <Input className={className} unstyled {...props} />;
}

export function InputGroupTextarea({ className, ...props }: TextareaProps): React.ReactElement {
  return <Textarea className={className} unstyled {...props} />;
}

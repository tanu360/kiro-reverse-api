import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The one notice, after the sign-in form's: a soft tag in the tone's light fill (the --pill-*
 * tokens, as the status pills), no border, the text in the tone's readable step, and a duotone
 * disc icon (index.css `[data-slot="alert"]`): a light circle in the tone with the glyph in the
 * full tone. Non-circled icons (a triangle) simply take the tone. 8 px corners like the controls;
 * a long message wraps.
 */
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-lg bg-(--badge-bg) px-3 py-2 text-(--badge-fg) text-sm leading-5 has-[>svg]:has-data-[slot=alert-action]:grid-cols-[calc(var(--spacing)*4.5)_1fr_auto] has-[>svg]:grid-cols-[calc(var(--spacing)*4.5)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] [&>svg]:mt-px [&>svg]:size-4.5 [&>svg]:text-(--badge-disc)",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default:
          "[--badge-bg:var(--pill-neutral-bg)] [--badge-disc:var(--pill-neutral)] [--badge-fg:var(--pill-neutral-fg)]",
        error:
          "[--badge-bg:var(--pill-error-bg)] [--badge-disc:var(--pill-error)] [--badge-fg:var(--pill-error-fg)]",
        info: "[--badge-bg:var(--pill-primary-bg)] [--badge-disc:var(--pill-primary)] [--badge-fg:var(--pill-primary-fg)]",
        success:
          "[--badge-bg:var(--pill-success-bg)] [--badge-disc:var(--pill-success)] [--badge-fg:var(--pill-success-fg)]",
        warning:
          "[--badge-bg:var(--pill-warning-bg)] [--badge-disc:var(--pill-warning)] [--badge-fg:var(--pill-warning-fg)]",
      },
    },
  },
);

export type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants>): React.ReactElement {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("font-medium [svg~&]:col-start-2", className)}
      data-slot="alert-title"
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 [svg~&]:col-start-2",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

export function AlertAction({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3",
        className,
      )}
      data-slot="alert-action"
      {...props}
    />
  );
}

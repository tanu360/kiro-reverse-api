import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The one notice, after the sign-in form's: a soft tag in the tone's light fill (the --pill-*
 * tokens, as the status pills), no border, the text in the tone's readable step, and a duotone
 * disc icon (index.css `[data-slot="alert"]`): a light circle in the tone with the glyph in the
 * full tone. Non-circled icons (a triangle) simply take the tone. 8 px corners like the controls;
 * a long message wraps. `size="sm"` is the inline notice: 12 px text and a 14 px icon, for a line
 * under a card or table (a server-changed note, a memory note).
 */
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-lg bg-(--badge-bg) px-3 text-(--badge-fg) has-[>svg]:has-data-[slot=alert-action]:grid-cols-[var(--alert-icon)_1fr_auto] has-[>svg]:grid-cols-[var(--alert-icon)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] [&>svg]:size-(--alert-icon) [&>svg]:text-(--badge-disc)",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "py-2 text-sm leading-5 [--alert-icon:--spacing(4.5)] [&>svg]:mt-px",
        sm: "py-2 text-xs leading-4 [--alert-icon:--spacing(3.5)] [&>svg]:mt-px",
      },
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
export type AlertSize = NonNullable<VariantProps<typeof alertVariants>["size"]>;

export function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants>): React.ReactElement {
  return (
    <div
      className={cn(alertVariants({ size, variant }), className)}
      data-size={size ?? "default"}
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

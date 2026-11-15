import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The one notice, after Vercel's Geist Note in its filled form: a light fill of the tone with a
 * hairline a step deeper, the text and the outline icon in a dark step of the tone, and the
 * action (AlertAction) an outline button in the tone (Button variant "tone", which reads
 * --badge-fg). The colours are the --notice-* tokens in index.css. 8 px corners
 * like the controls; a long message wraps. With an action on a wide screen the text centres on
 * the button and the padding beside the button tightens. `size="sm"` is the inline notice:
 * 12 px text and a 14 px icon, for a line under a card or table (a server-changed note, a memory
 * note).
 */
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-lg border border-(--notice-line) bg-(--badge-bg) px-3 text-(--badge-fg) has-[>svg]:has-data-[slot=alert-action]:grid-cols-[var(--alert-icon)_1fr_auto] has-[>svg]:grid-cols-[var(--alert-icon)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] sm:has-data-[slot=alert-action]:items-center sm:has-data-[slot=alert-action]:pe-1.5 [&>svg]:size-(--alert-icon) [&>svg]:text-(--badge-disc)",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "py-2 text-sm leading-5 [--alert-icon:--spacing(4.5)] sm:has-data-[slot=alert-action]:py-1.5 [&>svg]:mt-px sm:has-data-[slot=alert-action]:[&>svg]:mt-0",
        sm: "py-2 text-xs leading-4 [--alert-icon:--spacing(3.5)] sm:has-data-[slot=alert-action]:py-1.5 [&>svg]:mt-px sm:has-data-[slot=alert-action]:[&>svg]:mt-0",
      },
      variant: {
        default:
          "[--badge-bg:var(--notice-neutral-bg)] [--badge-disc:var(--notice-neutral-fg)] [--badge-fg:var(--notice-neutral-fg)] [--notice-line:var(--notice-neutral-line)]",
        error:
          "[--badge-bg:var(--notice-error-bg)] [--badge-disc:var(--notice-error-fg)] [--badge-fg:var(--notice-error-fg)] [--notice-line:var(--notice-error-line)]",
        info: "[--badge-bg:var(--notice-info-bg)] [--badge-disc:var(--notice-info-fg)] [--badge-fg:var(--notice-info-fg)] [--notice-line:var(--notice-info-line)]",
        success:
          "[--badge-bg:var(--notice-success-bg)] [--badge-disc:var(--notice-success-fg)] [--badge-fg:var(--notice-success-fg)] [--notice-line:var(--notice-success-line)]",
        warning:
          "[--badge-bg:var(--notice-warning-bg)] [--badge-disc:var(--notice-warning-fg)] [--badge-fg:var(--notice-warning-fg)] [--notice-line:var(--notice-warning-line)]",
      },
    },
  },
);

export function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>): React.ReactElement {
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
      className={cn("flex flex-col gap-2.5 [svg~&]:col-start-2", className)}
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
        "flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:[[data-slot=alert-title]~&]:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3",
        className,
      )}
      data-slot="alert-action"
      {...props}
    />
  );
}

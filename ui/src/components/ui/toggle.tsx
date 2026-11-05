"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "@/lib/utils";

export const toggleVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base text-foreground outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-outline disabled:pointer-events-none disabled:opacity-64 aria-disabled:opacity-64 data-pressed:bg-(--neutral-button-hover) data-pressed:text-foreground sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        // The button heights (button.tsx): 36 / 32 / 40 coarse, 44 / 40 lg, 32 / 28 / 36 sm.
        default:
          "h-9 min-w-9 px-[calc(--spacing(2)-1px)] sm:h-8 sm:min-w-8 pointer-coarse:h-10 pointer-coarse:min-w-10",
        lg: "h-11 min-w-11 px-[calc(--spacing(2.5)-1px)] sm:h-10 sm:min-w-10",
        sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7 pointer-coarse:h-9 pointer-coarse:min-w-9",
      },
      variant: {
        default: "border-transparent",
        // The neutral (outline) button's tint and hairline (index.css --neutral-button-*); pressed
        // takes the selected-segment tint.
        outline:
          "border-(--neutral-button-border) bg-(--neutral-button) hover:bg-(--neutral-button-hover)",
      },
    },
  },
);

export function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props &
  VariantProps<typeof toggleVariants>): React.ReactElement {
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { TogglePrimitive };

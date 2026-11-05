"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "@/lib/utils";

/*
 * A chip of a phone and tablet nav row (Settings' section nav below xl): a hairline pill on the
 * card fill, muted until hovered, the surface step and a firmer edge for the current entry
 * (aria-current), red text and a red tint for a danger entry. 40 px tall on phones and touch
 * screens, 36 px from sm up. Theme tokens only.
 */
export const navChipVariants = cva(
  "inline-flex min-h-10 shrink-0 cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-full border border-border bg-card px-3 font-medium text-sm outline-none transition-colors focus-outline sm:min-h-9 pointer-coarse:min-h-10 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    defaultVariants: { tone: "default" },
    variants: {
      tone: {
        default:
          "text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=true]:border-border-strong aria-[current=true]:bg-surface-2 aria-[current=true]:text-foreground aria-[current=page]:border-border-strong aria-[current=page]:bg-surface-2 aria-[current=page]:text-foreground",
        danger:
          "text-destructive-foreground hover:bg-error-surface aria-[current=true]:border-destructive/32 aria-[current=true]:bg-error-surface aria-[current=page]:border-destructive/32 aria-[current=page]:bg-error-surface",
      },
    },
  },
);

export interface NavChipProps extends useRender.ComponentProps<"a"> {
  tone?: VariantProps<typeof navChipVariants>["tone"];
  /** Marks the current entry (aria-current="true"); leave unset to pass aria-current yourself. */
  current?: boolean;
}

/** An `<a>` by default; `render` swaps the element (a router Link, a button). */
export function NavChip({
  className,
  tone,
  current,
  render,
  ...props
}: NavChipProps): React.ReactElement {
  const defaultProps = {
    "aria-current": current ? ("true" as const) : undefined,
    className: cn(navChipVariants({ tone }), className),
    "data-slot": "nav-chip",
  };
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

import type React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      // Base tint is foreground at 8%: --muted (zinc-50) was nearly invisible on white cards.
      className={cn(
        "animate-skeleton rounded-sm [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--skeleton-base)_0_0/200%_100%_fixed] [--skeleton-base:color-mix(in_srgb,var(--color-foreground)_8%,transparent)] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

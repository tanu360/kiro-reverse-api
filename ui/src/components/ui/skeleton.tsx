import type React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      // t3code's skeleton: muted-foreground at 15%, breathing in opacity (index.css).
      className={cn(
        "rounded-sm bg-muted-foreground/15 motion-safe:animate-skeleton",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

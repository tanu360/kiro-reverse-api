import type React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      // t3code's skeleton: the --skeleton tint (muted-foreground at 15%), breathing in opacity
      // (index.css animate-skeleton), with 4 px corners.
      className={cn("rounded-sm bg-skeleton animate-skeleton", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

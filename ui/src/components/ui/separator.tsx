import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import type React from "react";
import { cn } from "@/lib/utils";

/**
 * A hairline in the --border colour. `fade`: a horizontal one that fades out toward both ends
 * (the sign-in pages, between the form and the link to the other sign-in page).
 */
export function Separator({
  className,
  orientation = "horizontal",
  fade = false,
  ...props
}: SeparatorPrimitive.Props & { fade?: boolean }): React.ReactElement {
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        fade ? "bg-linear-to-r from-transparent via-border to-transparent" : "bg-border",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

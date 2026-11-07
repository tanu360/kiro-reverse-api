"use client";

// coss ui toolbar (https://coss.com/ui/docs/components/toolbar), from the @coss registry.
// Kiro patches: a `variant` on the bar, from theme tokens only. `default` is the card bar;
// `inverted` is the purple batch bar (the main button's fill and finish, PRIMARY_FINISH), with a
// light focus outline and separators in the label colour, so on-primary buttons read on it.
import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { PRIMARY_FINISH } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const toolbarVariants = cva("relative flex items-center gap-2 rounded-xl border p-1", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      inverted: cn(
        "border-primary bg-primary text-primary-foreground [--color-ring:var(--primary-foreground)]",
        PRIMARY_FINISH,
      ),
    },
  },
});

export function Toolbar({
  className,
  variant,
  ...props
}: ToolbarPrimitive.Root.Props & VariantProps<typeof toolbarVariants>): React.ReactElement {
  return (
    <ToolbarPrimitive.Root
      className={cn(toolbarVariants({ variant }), className)}
      data-slot="toolbar"
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export function ToolbarButton({
  className,
  ...props
}: ToolbarPrimitive.Button.Props): React.ReactElement {
  return (
    <ToolbarPrimitive.Button className={cn(className)} data-slot="toolbar-button" {...props} />
  );
}

export function ToolbarGroup({
  className,
  ...props
}: ToolbarPrimitive.Group.Props): React.ReactElement {
  return (
    <ToolbarPrimitive.Group
      className={cn("flex items-center gap-1", className)}
      data-slot="toolbar-group"
      {...props}
    />
  );
}

/** A hairline between groups: the border colour, or the label colour at 24 % on the inverted bar. */
export function ToolbarSeparator({
  className,
  ...props
}: ToolbarPrimitive.Separator.Props): React.ReactElement {
  return (
    <ToolbarPrimitive.Separator
      className={cn(
        "shrink-0 bg-border in-data-[variant=inverted]:bg-primary-foreground/24 data-[orientation=horizontal]:my-0.5 data-[orientation=vertical]:my-1.5 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="toolbar-separator"
      {...props}
    />
  );
}

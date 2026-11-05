"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type React from "react";
import { cn } from "@/lib/utils";

/**
 * A form label: 14 / 20 px medium at every width, the same as FieldLabel and SelectLabel.
 * `option`: the caption of a checkbox, radio or switch it wraps (the sign-in "Remember me"),
 * regular weight in muted text, with a 40 px row to tap.
 */
export function Label({
  className,
  render,
  variant = "default",
  ...props
}: useRender.ComponentProps<"label"> & {
  variant?: "default" | "option";
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 font-medium text-foreground text-sm/5",
      variant === "option" && "min-h-10 cursor-pointer font-normal text-muted-foreground",
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

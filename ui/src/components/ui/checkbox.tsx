"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type React from "react";
import { cn } from "@/lib/utils";

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props): React.ReactElement {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        // The sign-in checkbox: a flat 16 px box in the field fill with the firm control edge
        // (index.css --border-strong, 3:1) while unchecked, the field's hover tint under the
        // pointer, solid purple once checked.
        "relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-strong bg-field outline-none focus-outline hover:bg-field-hover aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 data-disabled:cursor-not-allowed data-disabled:opacity-64 data-checked:border-primary",
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="absolute -inset-px flex items-center justify-center rounded-sm text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground"
        data-slot="checkbox-indicator"
        render={(
          props: React.ComponentProps<"span">,
          state: CheckboxPrimitive.Indicator.State,
        ) => (
          <span {...props}>
            {state.indeterminate ? (
              <HugeiconsIcon aria-hidden="true" className="size-3" icon={MinusIcon} strokeWidth={3} />
            ) : (
              <HugeiconsIcon aria-hidden="true" className="size-3" icon={CheckIcon} strokeWidth={3} />
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { CheckboxPrimitive };

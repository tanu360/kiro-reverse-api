"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type React from "react";
import { cn } from "@/lib/utils";

export function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props): React.ReactElement {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col gap-3", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

export function Radio({ className, ...props }: RadioPrimitive.Root.Props): React.ReactElement {
  return (
    <RadioPrimitive.Root
      className={cn(
        // The checkbox's look (checkbox.tsx), round: the firm control edge, the field's hover tint.
        "relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-strong bg-field focus-outline hover:bg-field-hover aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 data-disabled:cursor-not-allowed data-disabled:opacity-64",
        className,
      )}
      data-slot="radio"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="absolute -inset-px flex size-4 items-center justify-center rounded-full before:size-1.5 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary"
        data-slot="radio-indicator"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroupPrimitive, RadioPrimitive };

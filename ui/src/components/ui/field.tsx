"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import type React from "react";
import { cn } from "@/lib/utils";

export function Field({ className, ...props }: FieldPrimitive.Root.Props): React.ReactElement {
  return (
    <FieldPrimitive.Root
      className={cn("flex flex-col items-start gap-2", className)}
      data-slot="field"
      {...props}
    />
  );
}

export function FieldLabel({
  className,
  ...props
}: FieldPrimitive.Label.Props): React.ReactElement {
  return (
    <FieldPrimitive.Label
      className={cn(
        "inline-flex items-center gap-2 font-medium text-foreground text-sm/5 data-disabled:opacity-64",
        className,
      )}
      data-slot="field-label"
      {...props}
    />
  );
}

export function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props): React.ReactElement {
  return (
    <FieldPrimitive.Description
      className={cn("text-muted-foreground text-xs leading-normal", className)}
      data-slot="field-description"
      {...props}
    />
  );
}

/**
 * A FieldDescription-styled note with no Field around it (Base UI's FieldDescription needs a
 * Field.Root): a step-level hint in a flow, a note under a group of fields. Same 12 px muted
 * line, at most 42rem wide.
 */
export function FieldHint({ className, ...props }: React.ComponentProps<"p">): React.ReactElement {
  return (
    <p
      className={cn(
        "max-w-2xl text-pretty text-muted-foreground text-xs leading-normal",
        className,
      )}
      data-slot="field-hint"
      {...props}
    />
  );
}

/**
 * One choice inside a Field (Base UI Field.Item): a radio or checkbox in it keeps its own id and
 * label instead of taking the Field's single control id.
 */
export function FieldItem(props: FieldPrimitive.Item.Props): React.ReactElement {
  return <FieldPrimitive.Item data-slot="field-item" {...props} />;
}

export function FieldError({
  className,
  ...props
}: FieldPrimitive.Error.Props): React.ReactElement {
  return (
    <FieldPrimitive.Error
      className={cn("text-destructive-foreground text-xs leading-normal", className)}
      data-slot="field-error"
      {...props}
    />
  );
}

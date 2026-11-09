"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.ComponentPropsWithoutRef<"textarea"> &
  React.RefAttributes<HTMLTextAreaElement> & {
    size?: "sm" | "default" | "lg" | number;
    /**
     * `mono`: Geist Mono at 14 px from sm up (16 px on phones, so iOS does not zoom), for JSON,
     * tokens and keys. With `wrap="off"` long lines scroll instead of wrapping.
     */
    variant?: "default" | "mono";
    unstyled?: boolean;
  };

/**
 * A field that grows with its text up to 16rem. `rows={1}` is the single-line mode: no
 * three-line floor, so it starts at an Input's height and hugs a value that wraps (a UUID on a
 * phone); with a coarse pointer it is as tall as the Input there too.
 */

export function Textarea({
  className,
  size = "default",
  variant = "default",
  unstyled = false,
  ref,
  ...props
}: TextareaProps): React.ReactElement {
  const singleLine = props.rows === 1;
  return (
    <span
      className={
        cn(
          !unstyled &&
            // The input's soft field fill (index.css --field-*), no focus ring.
            "relative inline-grid w-full rounded-lg border border-field-border bg-field text-base text-foreground transition-[background-color,border-color] duration-150 hover:bg-field-hover has-focus-visible:border-field-border-focus has-focus-visible:bg-field-focus has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-disabled:opacity-64 sm:text-sm",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        ref={ref}
        value={props.value}
        defaultValue={props.defaultValue}
        disabled={props.disabled}
        id={props.id}
        name={props.name}
        render={(defaultProps: React.ComponentProps<"textarea">) => (
          <textarea
            className={cn(
              // It grows with its text up to 16rem (field-sizing), so it has no resize grip.
              "field-sizing-content max-h-64 w-full resize-none rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] text-foreground outline-none placeholder:text-placeholder",
              !singleLine && "min-h-17.5 max-sm:min-h-20.5",
              singleLine && size === "default" && "pointer-coarse:py-[calc(--spacing(2)-1px)]",
              props.wrap === "off" ? "overflow-x-auto whitespace-pre" : "wrap-anywhere",
              variant === "mono" && "font-mono",
              size === "sm" && "px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)]",
              size === "sm" && !singleLine && "min-h-16.5 max-sm:min-h-19.5",
              size === "lg" && "py-[calc(--spacing(2)-1px)]",
              size === "lg" && !singleLine && "min-h-18.5 max-sm:min-h-21.5",
            )}
            data-slot="textarea"
            {...mergeProps(defaultProps, props)}
          />
        )}
      />
    </span>
  );
}

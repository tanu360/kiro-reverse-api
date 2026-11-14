"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  "size"
> & {
  size?: "sm" | "default" | "lg" | number;
  /** `code`: Geist Mono, for keys, tokens, URLs and IDs. */
  variant?: "default" | "code";
  unstyled?: boolean;
  nativeInput?: boolean;
};

export function Input({
  className,
  size = "default",
  variant = "default",
  unstyled = false,
  nativeInput = false,
  style,
  ...props
}: InputProps): React.ReactElement {
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] text-foreground outline-none [transition:background-color_5000000s_ease-in-out_0s] placeholder:text-placeholder autofill:[-webkit-text-fill-color:var(--foreground)]",
    // Border included: 36 px by default, 32 px sm, on phones and desktops alike (the buttons'
    // heights). Touch screens grow them to 40 / 36 px, as the select trigger and the buttons.
    // Only the height: the text keeps the field's own line height (20 px at 14 px) and the browser
    // centres it, so a text selection hugs the words instead of filling the whole field.
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] pointer-coarse:h-8.5",
    // lg is the sign-in password field: 44 px on phones and touch screens, 40 px from sm up.
    size === "lg"
      ? "h-10.5 sm:h-9.5 pointer-coarse:h-10.5"
      : size !== "sm" && "pointer-coarse:h-9.5",
    variant === "code" && "font-mono",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "number" &&
      "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            // The sign-in password field's soft fill (index.css --field-*); focus shows by the
            // border colour alone.
            "relative inline-flex w-full rounded-lg border border-field-border bg-field text-control text-foreground transition-[background-color,border-color] duration-150 hover:bg-field-hover has-focus-visible:border-field-border-focus has-focus-visible:bg-field-focus has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-autofill:bg-foreground/4 has-disabled:opacity-64 dark:has-autofill:bg-foreground/8",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          style={typeof style === "function" ? undefined : style}
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          style={style}
          {...props}
        />
      )}
    </span>
  );
}

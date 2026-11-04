"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/*
 * Class strings from t3code apps/web/src/components/ui/button.tsx. Kiro differences: no drop
 * shadows (the project keeps shadows to floating layers), the focus cue is the focus-outline
 * utility (index.css), no will-change layer (it re-rasterised the label), and the filled variants
 * are the sign-in button (FILLED). The grain sits on the ::before layer every button already has;
 * ::after stays free for the touch hit area.
 * Icons take --control-icon-color: the label colour, or muted on outline and ghost.
 * Kiro adds `soft` (a purple tint for a secondary action that needs colour) and `quiet` (an icon
 * button that changes only its colour on hover).
 */
/**
 * The filled variants (default, destructive) are the sign-in button: the faint film grain
 * (index.css grain-overlay at 0.1) under the label, a 1 px white inner highlight along the top
 * edge (a black one while pressed), no drop shadow, and the icon at 80 %.
 */
const FILLED =
  "grain-overlay [--grain-overlay-opacity:0.1] not-disabled:not-aria-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [&_svg:not([class*='opacity-'])]:opacity-80";

export const buttonVariants = cva(
  "[--control-icon-color:currentColor] relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-outline disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 data-loading:select-none data-loading:text-transparent sm:text-sm [&_svg:not([class*='text-']):not([data-slot=button-loading-indicator])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        // The sign-in button: 44 px on phones and touch screens, 40 px from sm up (the lg field).
        lg: "h-11 px-[calc(--spacing(3.5)-1px)] sm:h-10 pointer-coarse:h-11",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: cn(
          FILLED,
          "border-primary bg-primary text-primary-foreground *:data-[slot=button-loading-indicator]:text-primary-foreground [:hover,[data-pressed]]:bg-primary/90",
        ),
        destructive: cn(
          FILLED,
          "border-destructive bg-destructive text-primary-foreground *:data-[slot=button-loading-indicator]:text-primary-foreground [:hover,[data-pressed]]:bg-destructive/90",
        ),
        // The outline buttons wear the field fill (index.css --field-*), like the inputs beside them.
        "destructive-outline":
          "border-field-border bg-field text-destructive-foreground *:data-[slot=button-loading-indicator]:text-foreground [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4",
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground *:data-[slot=button-loading-indicator]:text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        link: "border-transparent text-foreground underline-offset-4 *:data-[slot=button-loading-indicator]:text-foreground [:hover,[data-pressed]]:underline",
        outline:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-field-border bg-field text-foreground *:data-[slot=button-loading-indicator]:text-foreground [:hover,[data-pressed]]:bg-field-hover",
        // Kiro: a tinted purple action (Export) that sits between outline and the solid primary.
        // The label and icon share the accent text colour, AA on the tint in both themes.
        soft: "[--control-icon-color:currentColor] border-transparent bg-info/10 text-info-foreground *:data-[slot=button-loading-indicator]:text-info-foreground dark:bg-info/16 [:hover,[data-pressed]]:bg-info/16 dark:[:hover,[data-pressed]]:bg-info/24",
        // Kiro: an icon button that only changes its colour on hover, with no fill behind it.
        quiet:
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground *:data-[slot=button-loading-indicator]:text-foreground aria-pressed:text-foreground data-popup-open:text-foreground [:hover,[data-pressed]]:text-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground *:data-[slot=button-loading-indicator]:text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled: boolean = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: (
      <>
        {children}
        {loading && (
          <Spinner
            className="pointer-events-none absolute"
            data-slot="button-loading-indicator"
          />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-disabled": loading || undefined,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

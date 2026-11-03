"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";

/*
 * Pills: fully rounded, a leading icon, medium weight. Each tone sets five colours as custom
 * properties and each variant paints with them, so tone and variant combine freely:
 *   --badge-tint      the hue the soft fill and border are mixed from
 *   --badge-fg        text on the soft fill (AA on it in both themes)
 *   --badge-disc      the filled circle behind a disc icon, and an outline pill's icon
 *   --badge-solid     the solid fill (white or dark text on it is AA)
 *   --badge-solid-fg  text on the solid fill
 * Variants then set --badge-dot and --badge-glyph (the disc and its knocked-out glyph) and
 * --badge-icon (a line icon).
 * Disc icons (a circled lucide icon such as CircleCheck, CircleX or Clock) are drawn as a filled
 * circle with the glyph knocked out in white; see `[data-badge-icon="disc"]` in index.css.
 */
export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-transparent font-medium leading-none outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-(--badge-icon) [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      tone: "neutral",
      variant: "soft",
    },
    variants: {
      size: {
        sm: "h-5 px-1.5 text-[0.6875rem] has-[>svg:first-child]:ps-1 [&_svg:not([class*='size-'])]:size-3",
        default:
          "h-5.5 px-2 text-xs has-[>svg:first-child]:ps-1 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-7 gap-1.5 px-2.5 text-sm has-[>svg:first-child]:ps-1.5 [&_svg:not([class*='size-'])]:size-4",
      },
      tone: {
        neutral:
          "[--badge-disc:var(--color-zinc-400)] [--badge-fg:var(--color-zinc-700)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--color-zinc-800)] [--badge-tint:var(--color-zinc-500)] dark:[--badge-disc:var(--color-zinc-500)] dark:[--badge-fg:var(--color-zinc-300)] dark:[--badge-solid-fg:var(--color-zinc-900)] dark:[--badge-solid:var(--color-zinc-100)]",
        primary:
          "[--badge-disc:var(--primary)] [--badge-fg:var(--info-foreground)] [--badge-solid-fg:var(--primary-foreground)] [--badge-solid:var(--primary)] [--badge-tint:var(--primary)]",
        info: "[--badge-disc:var(--info)] [--badge-fg:var(--info-foreground)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--info)] [--badge-tint:var(--info)]",
        success:
          "[--badge-disc:var(--success)] [--badge-fg:var(--success-foreground)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--color-emerald-700)] [--badge-tint:var(--success)] dark:[--badge-fg:var(--color-emerald-300)]",
        // amber-800 text, not the amber-700 token: amber-700 is only 4.5:1 on the amber tint.
        warning:
          "[--badge-disc:var(--warning)] [--badge-fg:var(--color-amber-800)] [--badge-solid-fg:var(--color-amber-950)] [--badge-solid:var(--color-amber-400)] [--badge-tint:var(--warning)] dark:[--badge-fg:var(--color-amber-300)]",
        destructive:
          "[--badge-disc:var(--destructive)] [--badge-fg:var(--destructive-foreground)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--destructive)] [--badge-tint:var(--destructive)]",
      },
      variant: {
        soft: "bg-[color-mix(in_oklab,var(--badge-tint)_11%,transparent)] text-(--badge-fg) [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--color-white)] [--badge-icon:var(--badge-fg)] dark:bg-[color-mix(in_oklab,var(--badge-tint)_18%,transparent)] [button&,a&]:hover:bg-[color-mix(in_oklab,var(--badge-tint)_18%,transparent)] dark:[button&,a&]:hover:bg-[color-mix(in_oklab,var(--badge-tint)_26%,transparent)]",
        "soft-outline":
          "border-[color-mix(in_oklab,var(--badge-tint)_28%,transparent)] bg-[color-mix(in_oklab,var(--badge-tint)_9%,transparent)] text-(--badge-fg) [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--color-white)] [--badge-icon:var(--badge-fg)] dark:border-[color-mix(in_oklab,var(--badge-tint)_36%,transparent)] dark:bg-[color-mix(in_oklab,var(--badge-tint)_15%,transparent)] [button&,a&]:hover:bg-[color-mix(in_oklab,var(--badge-tint)_16%,transparent)]",
        solid:
          "bg-(--badge-solid) text-(--badge-solid-fg) [--badge-dot:var(--badge-solid-fg)] [--badge-glyph:var(--badge-solid)] [--badge-icon:var(--badge-solid-fg)] [button&,a&]:hover:opacity-90",
        outline:
          "border-border bg-background text-foreground [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--color-white)] [--badge-icon:var(--badge-disc)] dark:border-input dark:bg-input/16 [button&,a&]:hover:bg-accent",
      },
    },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: VariantProps<typeof badgeVariants>["size"];
  /** Leading icon. Circled lucide icons read best as `disc` (the default). */
  icon?: LucideIcon;
  /** `disc`: a filled colour circle with a white glyph. `line`: a plain icon in the text colour. */
  iconStyle?: "disc" | "line";
}

/** The leading icon of a pill built by hand from `badgeVariants` (for example a button). */
export function BadgeIcon({
  icon: Icon,
  iconStyle = "disc",
}: {
  icon: LucideIcon;
  iconStyle?: "disc" | "line";
}): React.ReactElement {
  return <Icon aria-hidden="true" data-badge-icon={iconStyle} />;
}

export function Badge({
  className,
  tone,
  variant,
  size,
  icon,
  iconStyle = "disc",
  render,
  children,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, tone, variant })),
    "data-slot": "badge",
    children: icon ? (
      <>
        <BadgeIcon icon={icon} iconStyle={iconStyle} />
        {children}
      </>
    ) : (
      children
    ),
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

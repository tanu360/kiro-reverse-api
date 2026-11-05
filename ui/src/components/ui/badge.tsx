"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type React from "react";
import { cn } from "@/lib/utils";

/*
 * Pills: fully rounded, a leading icon, medium weight (a Kiro design; t3code's badges are square
 * tags). The soft pill follows a reference status set: a very light tint of the hue, no border
 * and no shadow, a solid disc in the hue with a white glyph, and the label in a darker step of
 * the same hue (AA on the tint, also on a selected table row). The colours are the --pill-*
 * tokens in index.css, which switch for the dark theme. Each tone sets six custom properties
 * and each variant paints with them, so tone and variant combine freely:
 *   --badge-tint      the hue the hover fill and the soft-outline border are mixed from
 *   --badge-bg        the soft fill
 *   --badge-fg        text on the soft fill (AA on it in both themes)
 *   --badge-disc      the filled circle behind a disc icon, and an outline pill's icon
 *   --badge-solid     the solid fill (white or dark text on it is AA)
 *   --badge-solid-fg  text on the solid fill
 * Variants then set --badge-dot and --badge-glyph (the disc and its knocked-out glyph) and
 * --badge-icon (a line icon).
 * Disc icons (a circled Hugeicons icon such as CircleCheck, CircleX or Clock01) are drawn as a filled
 * circle with the glyph knocked out; see `[data-badge-icon="disc"]` in index.css.
 */
export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-transparent font-medium leading-none outline-none transition-[background-color,box-shadow] focus-outline disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-(--badge-icon) [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      tone: "neutral",
      variant: "soft",
    },
    variants: {
      size: {
        sm: "h-5 px-1.5 text-2xs has-[>svg:first-child]:ps-1 [&_svg:not([class*='size-'])]:size-3",
        // The disc nearly fills the pill (a 2 px inset), as in the reference; line icons stay a
        // step smaller so they sit with the 12 px label instead of shouting over it.
        default:
          "h-6 px-2.5 text-xs has-[>svg:first-child]:ps-1 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='size-'])[data-badge-icon=line]]:size-3.5 has-[>svg[data-badge-icon=line]:first-child]:ps-2",
        lg: "h-7 gap-1.5 px-2.5 text-sm has-[>svg:first-child]:ps-1.5 [&_svg:not([class*='size-'])]:size-4",
      },
      // Every tone reads its colours from the --pill-* tokens (index.css), which already switch
      // for the dark theme. Only the solid fills keep their own Tailwind colours.
      tone: {
        neutral:
          "[--badge-bg:var(--pill-neutral-bg)] [--badge-disc:var(--pill-neutral)] [--badge-fg:var(--pill-neutral-fg)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--color-zinc-800)] [--badge-tint:var(--pill-neutral)] dark:[--badge-solid-fg:var(--color-zinc-900)] dark:[--badge-solid:var(--color-zinc-100)]",
        primary:
          "[--badge-bg:var(--pill-primary-bg)] [--badge-disc:var(--pill-primary)] [--badge-fg:var(--pill-primary-fg)] [--badge-solid-fg:var(--primary-foreground)] [--badge-solid:var(--primary)] [--badge-tint:var(--pill-primary)]",
        // Kiro purple, like primary: the app has no blue.
        info: "[--badge-bg:var(--pill-primary-bg)] [--badge-disc:var(--pill-primary)] [--badge-fg:var(--pill-primary-fg)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--info)] [--badge-tint:var(--pill-primary)]",
        success:
          "[--badge-bg:var(--pill-success-bg)] [--badge-disc:var(--pill-success)] [--badge-fg:var(--pill-success-fg)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--color-emerald-700)] [--badge-tint:var(--pill-success)]",
        warning:
          "[--badge-bg:var(--pill-warning-bg)] [--badge-disc:var(--pill-warning)] [--badge-fg:var(--pill-warning-fg)] [--badge-solid-fg:var(--color-amber-950)] [--badge-solid:var(--color-amber-400)] [--badge-tint:var(--pill-warning)]",
        destructive:
          "[--badge-bg:var(--pill-error-bg)] [--badge-disc:var(--pill-error)] [--badge-fg:var(--pill-error-fg)] [--badge-solid-fg:var(--color-white)] [--badge-solid:var(--destructive)] [--badge-tint:var(--pill-error)]",
      },
      variant: {
        soft: "bg-(--badge-bg) text-(--badge-fg) [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--pill-glyph)] [--badge-icon:var(--badge-fg)] [button&,a&]:hover:bg-[color-mix(in_srgb,var(--badge-tint)_20%,transparent)] dark:[button&,a&]:hover:bg-[color-mix(in_srgb,var(--badge-tint)_28%,transparent)]",
        "soft-outline":
          "border-[color-mix(in_srgb,var(--badge-tint)_32%,transparent)] bg-(--badge-bg) text-(--badge-fg) [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--pill-glyph)] [--badge-icon:var(--badge-fg)] dark:border-[color-mix(in_srgb,var(--badge-tint)_36%,transparent)] [button&,a&]:hover:bg-[color-mix(in_srgb,var(--badge-tint)_20%,transparent)]",
        // The buttons' faint film grain (index.css grain-overlay) on the solid fill.
        solid:
          "grain-overlay [--grain-overlay-opacity:0.1] bg-(--badge-solid) text-(--badge-solid-fg) [--badge-dot:var(--badge-solid-fg)] [--badge-glyph:var(--badge-solid)] [--badge-icon:var(--badge-solid-fg)] [button&,a&]:hover:opacity-90",
        outline:
          // The field fill and hairline (index.css --field-*), as the outline button.
          "border-field-border bg-field text-foreground [--badge-dot:var(--badge-disc)] [--badge-glyph:var(--pill-glyph)] [--badge-icon:var(--badge-disc)] [button&,a&]:hover:bg-field-hover",
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
  /** Leading icon (Hugeicons). Circled icons read best as `disc` (the default). */
  icon?: IconSvgElement;
  /** `disc`: a filled colour circle with a white glyph. `line`: a plain icon in the text colour. */
  iconStyle?: "disc" | "line";
}

/** The leading icon of a pill built by hand from `badgeVariants` (for example a button). */
export function BadgeIcon({
  icon: Icon,
  iconStyle = "disc",
}: {
  icon: IconSvgElement;
  iconStyle?: "disc" | "line";
}): React.ReactElement {
  return <HugeiconsIcon icon={Icon} aria-hidden="true" data-badge-icon={iconStyle} />;
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

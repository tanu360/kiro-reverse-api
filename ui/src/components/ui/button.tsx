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
 * share the sign-in button finish. The grain sits on the ::before layer every button already has;
 * ::after stays free for the touch hit area.
 * Icons take --control-icon-color: the label colour, or muted on ghost.
 * Every fill comes from the site's own colours (index.css): Kiro purple for the
 * main action, the sign-in showcase's API stickers for supporting ones (lime, periwinkle, peach;
 * --sticker-*), a faint tint of the surface for neutral actions (`outline`), solid zinc for
 * `secondary`, and red for `destructive`. Only the purple button wears the sign-in finish (grain and rim).
 * Kiro adds the sticker variants and `quiet` (an icon button that changes only its colour on
 * hover).
 */
/**
 * The sign-in button finish, on the purple main action only: the faint film grain (index.css
 * grain-overlay at 0.1) under the label, a 1 px white inner highlight along the top edge (a
 * black one while pressed), no drop shadow, and the icon at 80 %. Also worn by the sidebar's
 * Add account row (sidebar.tsx, variant "primary").
 */
export const PRIMARY_FINISH: string =
  "grain-overlay [--grain-overlay-opacity:0.1] not-disabled:not-aria-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [&_svg:not([class*='opacity-'])]:opacity-80";

/*
 * The sticker buttons (index.css --sticker-*): the pastel fill and its label colour, an edge and
 * a hover a step towards the label colour. Written out in full so Tailwind finds the classes.
 */
const STICKER_LOADING = "*:data-[slot=button-loading-indicator]:text-current";

export const buttonVariants = cva(
  "[--control-icon-color:currentColor] relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-outline disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 data-loading:select-none data-loading:text-transparent sm:text-sm [&_svg:not([class*='text-']):not([data-slot=button-loading-indicator])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      /*
       * The size scale follows shadcn's compact Base UI style (registry style-nova.css), desktop
       * values, with the matching field (input.tsx, select.tsx) of the same height beside it:
       *   xs       24 px, 12 px text   inline and table-cell actions
       *   sm       28 px, 13 px text   actions inside a card, row or toolbar (nova: 0.8rem)
       *   default  32 px, 14 px text   page and form actions, beside a default field
       *   lg       40 px, 14 px text   the sign-in button beside the 40 px sign-in field
       *                                (nova's lg is 36 px; the sign-in page is the reference)
       * Icon buttons are square at the same steps: icon-xs 24, icon-sm 28, icon 32, icon-lg 36.
       * Below sm (phones) every size is one 4 px step taller, with 14 px text from sm down and
       * 16 px from default up, so a thumb has a real target.
       */
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
        // 13 px text (--text-meta) in the 28 px desktop button, 14 px in the 32 px phone one.
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] text-sm sm:h-7 sm:text-[length:var(--text-meta)]",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: cn(
          PRIMARY_FINISH,
          "border-primary bg-primary text-primary-foreground *:data-[slot=button-loading-indicator]:text-primary-foreground [:hover,[data-pressed]]:bg-primary/90",
        ),
        destructive:
          "border-destructive bg-destructive text-primary-foreground *:data-[slot=button-loading-indicator]:text-primary-foreground [:hover,[data-pressed]]:bg-destructive/90",
        // Kiro: a destructive action that stays quiet until reached for: a red label and hairline,
        // then solid bright red with a white label and icon on hover, press or click, in both
        // themes (fixed colours, not theme tokens; white on red-600 is 4.8:1).
        // The outline button's shape in red: a faint red fill and border, solid red on hover.
        danger:
          "[--control-icon-color:currentColor] border-destructive/24 bg-destructive/8 text-destructive-foreground dark:border-destructive/32 dark:bg-destructive/14 *:data-[slot=button-loading-indicator]:text-current [:hover,[data-pressed]]:border-red-600 [:hover,[data-pressed]]:bg-red-600 [:hover,[data-pressed]]:text-white active:border-red-600 active:bg-red-600 active:text-white",
        // Supporting actions in the showcase's API sticker colours: lime (OpenAI) for Export,
        // periwinkle (Codex) for model refreshes, peach (Claude) for a soft destructive action.
        lime: cn(
          STICKER_LOADING,
          "border-[color-mix(in_srgb,var(--sticker-openai-fg)_20%,var(--sticker-openai))] bg-(--sticker-openai) text-(--sticker-openai-fg) [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--sticker-openai-fg)_9%,var(--sticker-openai))]",
        ),
        periwinkle: cn(
          STICKER_LOADING,
          "border-[color-mix(in_srgb,var(--sticker-codex-fg)_20%,var(--sticker-codex))] bg-(--sticker-codex) text-(--sticker-codex-fg) [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--sticker-codex-fg)_9%,var(--sticker-codex))]",
        ),
        peach: cn(
          STICKER_LOADING,
          "border-[color-mix(in_srgb,var(--sticker-claude-fg)_20%,var(--sticker-claude))] bg-(--sticker-claude) text-(--sticker-claude-fg) [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--sticker-claude-fg)_9%,var(--sticker-claude))]",
        ),
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground *:data-[slot=button-loading-indicator]:text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        link: "border-transparent text-foreground underline-offset-4 *:data-[slot=button-loading-indicator]:text-foreground [:hover,[data-pressed]]:underline",
        // Neutral actions (Cancel, Disable, Refresh tokens…): a faint foreground tint over the
        // surface it sits on, a step past a field's, and a step deeper on hover (index.css
        // --neutral-button-*).
        outline:
          "border-(--neutral-button-border) bg-(--neutral-button) text-foreground *:data-[slot=button-loading-indicator]:text-current [:hover,[data-pressed]]:bg-(--neutral-button-hover)",
        // Kiro: an icon button that only changes its colour on hover, with no fill behind it.
        quiet:
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground *:data-[slot=button-loading-indicator]:text-foreground aria-pressed:text-foreground data-popup-open:text-foreground [:hover,[data-pressed]]:text-foreground",
        secondary:
          "border-zinc-700 bg-zinc-800 text-zinc-50 *:data-[slot=button-loading-indicator]:text-current dark:border-zinc-400 dark:bg-zinc-200 dark:text-zinc-950 [:hover,[data-pressed]]:bg-zinc-700 dark:[:hover,[data-pressed]]:bg-zinc-300",
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

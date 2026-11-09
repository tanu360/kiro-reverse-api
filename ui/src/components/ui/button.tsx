"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/*
 * Class strings from t3code apps/web/src/components/ui/button.tsx. Kiro differences: no drop
 * shadows (the project keeps shadows to floating layers), the focus cue is the focus-outline
 * utility (index.css), no will-change layer (it re-rasterised the label), and the filled variants
 * share the sign-in button finish. The grain sits on the ::before layer every button already has;
 * ::after stays free for the touch hit area.
 * Icons take --control-icon-color: the label colour, or muted on ghost. While `loading`, a
 * Spinner takes the leading icon's place and the label stays (the sign-in button's look).
 * Every fill comes from the site's own colours (index.css): Kiro purple for the
 * main action, the sign-in showcase's API stickers for supporting ones (lime, periwinkle, peach;
 * --sticker-*), a faint tint of the surface for neutral actions (`outline`), the inverse fill
 * for `secondary` (--inverse), and solid red (--destructive-solid) for `destructive`. Only the
 * purple button wears the sign-in finish (grain and rim).
 * Kiro adds the sticker variants, `quiet` and `quiet-destructive` (icon buttons that change
 * only their colour on hover), `quiet-warning` (an amber icon with an amber hover fill),
 * `link-inline`, and `on-primary` / `on-primary-danger` for the purple batch toolbar.
 */
/**
 * The sign-in button finish, on the purple main action only: the faint film grain (index.css
 * grain-overlay at 0.1) under the label, a 1 px white inner highlight along the top edge (a
 * black one while pressed), no drop shadow, and the icon at 80 %. Also worn by the sidebar's
 * Add account row (sidebar.tsx, variant "primary").
 */
export const PRIMARY_FINISH: string =
  "grain-overlay [--grain-overlay-opacity:0.1] not-disabled:not-aria-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [&_svg:not([class*='opacity-'])]:opacity-80";

export const buttonVariants = cva(
  "[--control-icon-color:currentColor] relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-sm outline-none transition-[box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-outline disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:not-aria-busy:opacity-64 aria-busy:cursor-progress [&_svg:not([class*='text-'])]:text-(--control-icon-color) [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&>[data-slot=button-loading-indicator]+svg]:hidden",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      /*
       * One control height scale, shadcn's new-york scale, the same on phones and desktops
       * (a coarse pointer in brackets), shared with the fields (input.tsx, select.tsx,
       * number-field.tsx) and the segmented control:
       *   xs       24 px, 12 px text          inline and field-addon actions (Upload)
       *   sm       32 (36) px, 14 px text     actions inside a card, row or toolbar (Save, Edit, Add)
       *   default  36 (40) px, 14 px text     page-header actions and dialog footers
       *   lg       44 / 40 / 44 px, 16 / 14 px   the sign-in button beside the sign-in field
       *            (phone / sm and up / coarse pointer)
       * A text button pads 16 px, 12 px beside an icon (sm: 12 / 10 px; xs: 8 px). Icons are
       * 16 px (xs: 12 px). Icon buttons are square: icon-xs 24, icon-sm 32 (36), icon 36 (40),
       * icon-lg 40 (44). A coarse pointer grows the control itself, and every size keeps the
       * 44 px ::after hit area, so no call site sizes for touch.
       */
      size: {
        default:
          "h-9 px-[calc(--spacing(4)-1px)] has-[>svg]:px-[calc(--spacing(3)-1px)] pointer-coarse:h-10",
        icon: "size-9 pointer-coarse:size-10",
        "icon-lg": "size-10 pointer-coarse:size-11",
        "icon-sm": "size-8 pointer-coarse:size-9",
        "icon-xs": "size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3",
        // The sign-in button keeps the larger text (16 px on phones, 14 px from sm up).
        lg: "h-11 px-[calc(--spacing(3.5)-1px)] text-base sm:h-10 sm:text-sm pointer-coarse:h-11",
        sm: "h-8 gap-1.5 px-[calc(--spacing(3)-1px)] has-[>svg]:px-[calc(--spacing(2.5)-1px)] pointer-coarse:h-9",
        xs: "h-6 gap-1 px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3",
      },
      // Hover is the guarded `hover:` variant (only where the pointer can hover), never a bare
      // :hover, so a tapped button on a touch screen does not keep its hover fill; data-pressed
      // gives the same fill while a pointer or key presses it.
      variant: {
        // The main action, one per surface: Kiro purple with the sign-in finish.
        default: cn(
          PRIMARY_FINISH,
          "border-primary bg-primary text-primary-foreground hover:border-primary-hover data-pressed:border-primary-hover hover:bg-primary-hover data-pressed:bg-primary-hover",
        ),
        // The confirm button of a destructive dialog: solid red, white label (4.8:1), a step
        // deeper on hover.
        destructive:
          "border-destructive-solid bg-destructive-solid text-destructive-solid-foreground hover:bg-[color-mix(in_oklab,var(--destructive-solid)_88%,var(--color-black))] data-pressed:bg-[color-mix(in_oklab,var(--destructive-solid)_88%,var(--color-black))]",
        // An in-row destructive action that stays quiet until reached for: the outline button's
        // shape in a faint red with a red label, then solid red with a white label on hover or
        // press, in both themes. The dark tint is a dark: class, so the solid fill repeats under
        // dark: or the tint would outrank it there.
        danger:
          "border-destructive/24 bg-destructive/8 text-destructive-foreground dark:border-destructive/32 dark:bg-destructive/14 hover:border-destructive-solid data-pressed:border-destructive-solid hover:bg-destructive-solid data-pressed:bg-destructive-solid hover:text-destructive-solid-foreground data-pressed:text-destructive-solid-foreground dark:hover:border-destructive-solid dark:data-pressed:border-destructive-solid dark:hover:bg-destructive-solid dark:data-pressed:bg-destructive-solid",
        // Supporting actions in the showcase's API sticker colours: lime (OpenAI) for Export,
        // periwinkle (Codex) for model refreshes, peach (Claude) for a soft destructive action.
        lime: "border-[color-mix(in_srgb,var(--sticker-openai-fg)_20%,var(--sticker-openai))] bg-(--sticker-openai) text-(--sticker-openai-fg) hover:bg-[color-mix(in_srgb,var(--sticker-openai-fg)_9%,var(--sticker-openai))] data-pressed:bg-[color-mix(in_srgb,var(--sticker-openai-fg)_9%,var(--sticker-openai))]",
        periwinkle:
          "border-[color-mix(in_srgb,var(--sticker-codex-fg)_20%,var(--sticker-codex))] bg-(--sticker-codex) text-(--sticker-codex-fg) hover:bg-[color-mix(in_srgb,var(--sticker-codex-fg)_9%,var(--sticker-codex))] data-pressed:bg-[color-mix(in_srgb,var(--sticker-codex-fg)_9%,var(--sticker-codex))]",
        peach:
          "border-[color-mix(in_srgb,var(--sticker-claude-fg)_20%,var(--sticker-claude))] bg-(--sticker-claude) text-(--sticker-claude-fg) hover:bg-[color-mix(in_srgb,var(--sticker-claude-fg)_9%,var(--sticker-claude))] data-pressed:bg-[color-mix(in_srgb,var(--sticker-claude-fg)_9%,var(--sticker-claude))]",
        // Dialog Cancel and Back.
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground hover:bg-accent data-pressed:bg-accent",
        link: "border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline",
        // A link inside a sentence: the text's own size, no box, a dotted underline that turns
        // solid on hover. The Button drops the size classes for it.
        "link-inline":
          "h-auto whitespace-normal rounded-sm border-0 p-0 text-[length:inherit] text-foreground underline decoration-dotted underline-offset-3 sm:text-[length:inherit] [&:active:not([aria-haspopup])]:scale-100 hover:decoration-solid data-pressed:decoration-solid",
        // A field-like trigger (the Accounts filter selects in their label group): a faint
        // foreground tint with a hairline border, a step past a field's, and a step deeper on
        // hover (index.css --neutral-button-*). Supporting actions use `secondary`.
        outline:
          "border-(--neutral-button-border) bg-(--neutral-button) text-foreground hover:bg-(--neutral-button-hover) data-pressed:bg-(--neutral-button-hover)",
        // An icon button that changes only its colour on hover (row kebabs, eye toggles, header
        // icons); pressed (aria-pressed) or with its menu open (aria-expanded) it also takes the
        // accent fill, so an open menu's trigger reads as the one that opened it. Not
        // data-popup-open: a tooltip trigger gets that too once its tooltip shows, which filled
        // every hovered icon button with a tooltip (and turned the red hover back to foreground).
        quiet:
          "border-transparent text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground hover:text-foreground data-pressed:text-foreground",
        "quiet-destructive":
          "border-transparent text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground hover:text-destructive-foreground data-pressed:text-destructive-foreground",
        // A quiet icon that needs attention (the header's update notice): amber in every state,
        // so hover, press and an open popup show as a faint amber fill instead of a colour change.
        "quiet-warning":
          "border-transparent text-warning-foreground hover:bg-warning-surface data-pressed:bg-warning-surface aria-pressed:bg-warning-surface aria-expanded:bg-warning-surface",
        // Buttons on the purple batch toolbar: the toolbar's label colour, a white veil on hover.
        "on-primary":
          "border-transparent text-primary-foreground hover:bg-primary-foreground/14 data-pressed:bg-primary-foreground/14",
        "on-primary-danger":
          "border-transparent text-primary-foreground hover:bg-destructive-solid data-pressed:bg-destructive-solid hover:text-destructive-solid-foreground data-pressed:text-destructive-solid-foreground",
        // Supporting actions beside the purple primary (Refresh models, Edit, Restore from file,
        // Clear, a clean Save): a soft neutral fill with no border (coss ui / shadcn secondary),
        // a step deeper on hover and while pressed. The fill is the foreground mixed into the
        // surface it sits on, so it reads on cards, dialogs and the page in both themes.
        // An action inside a tinted notice (Alert's Retry, Dismiss): a hairline and label in the
        // notice's tone (its --badge-* colours). Light: the card's own fill, a faint tone wash on
        // hover. Dark: a brighter wash of the tone over the notice instead, since the card's
        // near-black fill sank into the dark tint like a hole. A grey fill read as dirt.
        tone: "border-[color-mix(in_srgb,var(--badge-disc,var(--border))_34%,transparent)] bg-card text-(--badge-fg,var(--foreground)) hover:bg-[color-mix(in_srgb,var(--badge-disc,var(--foreground))_9%,var(--card))] data-pressed:bg-[color-mix(in_srgb,var(--badge-disc,var(--foreground))_9%,var(--card))] dark:border-[color-mix(in_srgb,var(--badge-disc,var(--border))_42%,transparent)] dark:bg-[color-mix(in_srgb,var(--badge-disc,var(--foreground))_16%,transparent)] dark:hover:bg-[color-mix(in_srgb,var(--badge-disc,var(--foreground))_26%,transparent)] dark:data-pressed:bg-[color-mix(in_srgb,var(--badge-disc,var(--foreground))_26%,transparent)]",
        secondary:
          "border-transparent bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_11%,transparent)] data-pressed:bg-[color-mix(in_oklab,var(--foreground)_13%,transparent)]",
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  /**
   * Busy: the button keeps focus (aria-disabled and aria-busy, never native `disabled`), ignores
   * clicks, and a Spinner replaces its leading icon while the label stays.
   */
  loading?: boolean;
  /** The label shown while `loading` ("Saving…"); without it the usual label stays. */
  loadingText?: React.ReactNode;
}

function preventWhileLoading(event: React.MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  loadingText,
  onClick,
  "aria-disabled": ariaDisabled,
  ...props
}: ButtonProps): React.ReactElement {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    children: loading ? (
      <>
        <Spinner aria-hidden="true" data-slot="button-loading-indicator" />
        {loadingText ?? children}
      </>
    ) : (
      children
    ),
    // An inline link takes the sentence's size, so it drops the size scale.
    className: cn(
      buttonVariants({ className, size: variant === "link-inline" ? null : size, variant }),
    ),
    "aria-busy": loading || undefined,
    // Loading wins over the caller's value: merged later, an explicit aria-disabled={undefined}
    // or false would otherwise clear it while busy.
    "aria-disabled": loading ? true : ariaDisabled,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    // While loading, a click (mouse, Enter or Space) does nothing, a submit included.
    onClick: loading ? preventWhileLoading : onClick,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

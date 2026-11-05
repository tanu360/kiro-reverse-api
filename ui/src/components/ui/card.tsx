"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { IconChip } from "@/components/shared/icon-chip";
import { cn } from "@/lib/utils";

/*
 * One card chrome for the app, taken from the Settings groups: an opaque card surface (--card)
 * under the --border hairline, 12 px radius, no shadow (shadows belong to floating layers).
 * Sections inside it share one rhythm: 16 px inline padding on phones and 20 px from sm up,
 * a 12 px (title only) or 16 px (title and description) header, a 16 px panel and a slim footer.
 * Dividers between sections are the subtle hairline (--border-subtle).
 */
export const cardVariants = cva(
  "relative flex flex-col rounded-xl border text-card-foreground [&>[data-slot^=card-]]:border-border-subtle",
  {
    defaultVariants: {
      divided: false,
      size: "default",
      tone: "default",
    },
    variants: {
      /** Every child after the first gets a hairline above it (header, rows, footer). */
      divided: {
        false: "[&>[data-slot=card-header]+[data-slot=card-panel]]:pt-0",
        true: "[&>*+*]:border-border-subtle [&>*+*]:border-t",
      },
      /** `sm` pads the card itself, for list cards and tiles that have no header or panel. */
      size: {
        default: "",
        sm: "gap-2 p-3",
      },
      tone: {
        default: "border-border bg-card",
        danger:
          "border-destructive/40 bg-error-surface [&>*+*]:border-destructive/24 [&>[data-slot^=card-]]:border-destructive/24",
      },
    },
  },
);

export type CardProps = useRender.ComponentProps<"div"> & VariantProps<typeof cardVariants>;

export function Card({
  className,
  render,
  tone,
  size,
  divided,
  ...props
}: CardProps): React.ReactElement {
  const defaultProps = {
    className: cn(cardVariants({ divided, size, tone }), className),
    "data-divided": divided ? "" : undefined,
    "data-size": size ?? "default",
    "data-slot": "card",
    "data-tone": tone ?? "default",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

/*
 * Header recipe. The header is a wrapping row: the optional icon chip, the heading block
 * (title over a stacked description, or title and an inline description on one baseline) and
 * the actions at the end. Actions wrap below on a narrow card instead of squeezing the title.
 * Items centre on the row; a stacked description moves them to the top and the padding to 16 px.
 */
// Literal class strings (Tailwind only sees classes written out in full).
const HEADER_CLASS =
  "flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 [&:has([data-slot$=-description][data-variant=stacked])]:items-start [&:has([data-slot$=-description][data-variant=stacked])]:py-4";
const HEADING_CLASS =
  "flex min-w-0 flex-1 basis-48 flex-col gap-1 [&:has(>[data-slot$=-description][data-variant=inline])]:flex-row [&:has(>[data-slot$=-description][data-variant=inline])]:flex-wrap [&:has(>[data-slot$=-description][data-variant=inline])]:items-baseline [&:has(>[data-slot$=-description][data-variant=inline])]:gap-x-2 [&:has(>[data-slot$=-description][data-variant=inline])]:gap-y-0.5";
const TITLE_CLASS =
  "flex min-h-6 min-w-0 items-center gap-2 font-semibold text-foreground text-heading leading-6";
const descriptionVariants = cva("", {
  defaultVariants: { variant: "stacked" },
  variants: {
    variant: {
      inline: "text-meta text-muted-foreground",
      stacked: "max-w-2xl text-pretty text-muted-foreground text-xs leading-normal",
    },
  },
});
// A 24 px minimum gap between the heading and the actions (12 px row gap + 12 px here).
const ACTION_CLASS = "ms-auto flex max-w-full shrink-0 flex-wrap items-center gap-2 ps-3";
const PANEL_CLASS = "min-w-0 flex-1 px-4 py-4 sm:px-5";
const FOOTER_CLASS =
  "flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-meta text-muted-foreground sm:px-5";

/**
 * The header's icon: a 28 px chip that takes 24 px of layout (the title row's height), so it
 * centres on the title line whether the header items centre or top-align.
 */
function HeaderIcon({
  icon,
  tone,
}: {
  icon: IconSvgElement;
  tone?: "default" | "danger";
}): React.ReactElement {
  return <IconChip className="-my-0.5" icon={icon} tone={tone} />;
}

type HeaderProps = useRender.ComponentProps<"div"> & {
  /** Drawn in an IconChip before the heading. */
  icon?: IconSvgElement;
  iconTone?: "default" | "danger";
};

export function CardFrame({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(
      "relative flex flex-col rounded-xl border border-border bg-card text-card-foreground [--clip-bottom:-1rem] [--clip-top:-1rem] has-data-[slot=table-container]:overflow-hidden *:data-[slot=card]:-m-px *:data-[slot=table-container]:-m-px *:data-[slot=table-container]:w-[calc(100%+2px)] *:not-first:data-[slot=card]:rounded-t-lg *:not-last:data-[slot=card]:rounded-b-lg *:data-[slot=card]:[clip-path:inset(var(--clip-top)_1px_var(--clip-bottom)_1px_round_calc(var(--radius-xl)-1px))] *:data-[slot=card]:last:[--clip-bottom:1px] *:data-[slot=card]:first:[--clip-top:1px]",
      className,
    ),
    "data-slot": "card-frame",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardFrameHeader({
  className,
  render,
  icon,
  iconTone,
  children,
  ...props
}: HeaderProps): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        {icon ? <HeaderIcon icon={icon} tone={iconTone} /> : null}
        {children}
      </>
    ),
    className: cn(HEADER_CLASS, className),
    "data-slot": "card-frame-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardFrameTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(TITLE_CLASS, className),
    "data-slot": "card-frame-title",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardFrameDescription({
  className,
  render,
  variant,
  ...props
}: useRender.ComponentProps<"div"> &
  VariantProps<typeof descriptionVariants>): React.ReactElement {
  const defaultProps = {
    className: cn(descriptionVariants({ variant }), className),
    "data-slot": "card-frame-description",
    "data-variant": variant ?? "stacked",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardFrameAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(ACTION_CLASS, className),
    "data-slot": "card-frame-action",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardFrameFooter({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(FOOTER_CLASS, className),
    "data-slot": "card-frame-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardHeader({
  className,
  render,
  icon,
  iconTone,
  children,
  ...props
}: HeaderProps): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        {icon ? <HeaderIcon icon={icon} tone={iconTone} /> : null}
        {children}
      </>
    ),
    className: cn(HEADER_CLASS, className),
    "data-slot": "card-header",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

/**
 * The header's title block: the title over a stacked description, or the title and an inline
 * description on one baseline (it switches by itself when its description is inline).
 */
export function CardHeading({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(HEADING_CLASS, className),
    "data-slot": "card-heading",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(TITLE_CLASS, className),
    "data-slot": "card-title",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

/**
 * `stacked` (default): a 12 px hint under the title, at most 42rem wide. `inline`: a 13 px muted
 * subtitle that follows the title on its baseline.
 */
export function CardDescription({
  className,
  render,
  variant,
  ...props
}: useRender.ComponentProps<"div"> &
  VariantProps<typeof descriptionVariants>): React.ReactElement {
  const defaultProps = {
    className: cn(descriptionVariants({ variant }), className),
    "data-slot": "card-description",
    "data-variant": variant ?? "stacked",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(ACTION_CLASS, className),
    "data-slot": "card-action",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export function CardPanel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(PANEL_CLASS, className),
    "data-slot": "card-panel",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

/** Status on the left, the action (sm buttons) on the right, under a hairline. */
export function CardFooter({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(FOOTER_CLASS, "border-t", className),
    "data-slot": "card-footer",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export { CardPanel as CardContent };

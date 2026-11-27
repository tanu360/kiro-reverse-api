"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { IconChip } from "@/components/shared/icon-chip";
import { CompactActionsContext } from "@/components/ui/compact-actions";
import { cn } from "@/lib/utils";

/*
 * One card chrome for the app, taken from the Settings groups: an opaque card surface (--card)
 * under the --border hairline, 12 px radius, no shadow (shadows belong to floating layers).
 * Sections inside it share one rhythm, shadcn's compact card spacing: 16 px on every side at
 * every width, for the header, the panel and the footer alike.
 * Dividers between sections are the subtle hairline (--border-subtle).
 */
const cardVariants = cva(
  "relative flex flex-col rounded-xl border text-card-foreground *:data-[slot^=card-]:border-border-subtle",
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
          "border-destructive/40 bg-error-surface [&>*+*]:border-destructive/24 *:data-[slot^=card-]:border-destructive/24",
      },
    },
  },
);

type CardProps = useRender.ComponentProps<"div"> & VariantProps<typeof cardVariants>;

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
 * Header recipe. The header is a row: the optional icon chip, the heading block (title over a
 * stacked description, or title and an inline description on one baseline) and the actions at
 * the end. The actions never drop under the heading: on a phone, and wherever their labels would
 * not fit beside the title, they show compact (CompactActionsContext: icon buttons, a cycling
 * picker). Items sit at
 * the top, so the chip and the actions line up with the title line (24 px) even when a
 * description or meta wraps under it. The padding is the card's own, 16 px on every side at
 * every width. A title-only header is 56 px, with or without actions.
 */
// Literal class strings (Tailwind only sees classes written out in full).
// It wraps only on a phone, for the description's row of its own (HEADING_CLASS).
const HEADER_CLASS = "flex flex-wrap items-start gap-3 p-4";
// The heading takes what the actions leave (basis-0), so they never wrap under it. On a phone its
// box dissolves (display: contents): its title row and description lay out in the header itself,
// the title row beside the actions and the description at the full width under both.
const HEADING_CLASS =
  "flex min-w-0 flex-1 basis-0 flex-col gap-1 pe-3 max-sm:contents max-sm:[&>:first-child]:min-w-0 max-sm:[&>:first-child]:flex-1 max-sm:[&>:first-child]:basis-0 [&:has(>[data-slot$=-description][data-variant=inline])]:flex-row [&:has(>[data-slot$=-description][data-variant=inline])]:flex-wrap [&:has(>[data-slot$=-description][data-variant=inline])]:items-baseline [&:has(>[data-slot$=-description][data-variant=inline])]:gap-x-2 [&:has(>[data-slot$=-description][data-variant=inline])]:gap-y-0.5";
const TITLE_CLASS =
  "flex min-h-6 min-w-0 items-center gap-2 font-semibold text-foreground text-heading leading-6";
// Phones: a row of its own under the title row (4 px below it, the header's 12 px gap less 8),
// in line with the title past the icon chip (28 px and the 12 px gap).
const descriptionVariants = cva(
  "max-sm:order-last max-sm:-mt-2 max-sm:basis-full max-sm:[[data-slot=icon-chip]~[data-slot=card-heading]>&]:ps-10",
  {
    defaultVariants: { variant: "stacked" },
    variants: {
      variant: {
        inline: "text-muted-foreground text-sm",
        stacked: "max-w-2xl text-pretty text-muted-foreground text-xs leading-normal",
      },
    },
  },
);
/*
 * A 24 px minimum gap between the heading and the actions (12 px row gap + the heading's 12 px
 * end padding). Beside the title, the actions centre in a 40 px box (44 px on a touch tablet,
 * 32 px on a phone: the tallest header control) pulled back to the 24 px title line, so any sm
 * control, segmented range or option row centres on the title without growing the header.
 */
const ACTION_CLASS =
  "-my-1 ms-auto flex min-h-8 shrink-0 items-center gap-2 sm:-my-2 sm:min-h-10 sm:pointer-coarse:-my-2.5 sm:pointer-coarse:min-h-11";

/**
 * What the compact choice depends on besides the widths: a language, a title, a breakpoint or a
 * number of actions that changes while the actions show compact leaves their kept full width
 * stale (their labels are hidden, so nothing resizes).
 */
function compactSignature(header: HTMLElement, action: HTMLElement): string {
  return [
    header.querySelector('[data-slot="card-title"]')?.textContent ?? "",
    // The controls, a segmented group as one: the same count compact (the picker's one button)
    // and full.
    action.querySelectorAll(
      'button:not([data-slot="segmented-control"] button), a, [data-slot="segmented-control"]',
    ).length,
    document.documentElement.lang,
    window.matchMedia("(min-width: 40rem)").matches,
  ].join("|");
}

/**
 * The width of an element's text on one line, whatever its box is stretched or squeezed to: the
 * text's own extent while it may not wrap, in CSS pixels (`scale` takes out a running transform).
 */
function oneLineWidth(element: HTMLElement, scale: number): number {
  const whiteSpace = element.style.whiteSpace;
  element.style.whiteSpace = "nowrap";
  const range = document.createRange();
  range.selectNodeContents(element);
  const measured = range.getBoundingClientRect().width / scale;
  element.style.whiteSpace = whiteSpace;
  return measured;
}

/**
 * The room the actions have beside the title on one line, in CSS pixels (a dialog's open
 * scale, which ResizeObserver does not see, is taken out), or null while the header is hidden.
 */
function roomForActions(header: HTMLElement, action: HTMLElement): number | null {
  if (header.offsetWidth === 0) return null;
  // The heading (or the title, in a frame header): not the icon chip, not an action.
  const heading = Array.from(header.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child !== action &&
      child.getAttribute("data-slot") !== "icon-chip" &&
      child.getAttribute("data-slot") !== "card-action",
  );
  if (!heading) return null;
  const row =
    heading.firstElementChild instanceof HTMLElement ? heading.firstElementChild : heading;
  const title =
    row.getAttribute("data-slot") === "card-title"
      ? row
      : row.querySelector<HTMLElement>('[data-slot="card-title"]');
  const headerRect = header.getBoundingClientRect();
  const scale = headerRect.width / header.offsetWidth || 1;
  const headerStyle = getComputedStyle(header);
  const headingStyle = getComputedStyle(heading);
  // From sm up the heading keeps its 12 px end padding; on a phone its box dissolves.
  const endPadding =
    headingStyle.display === "contents" ? 0 : parseFloat(headingStyle.paddingRight) || 0;
  const gap = parseFloat(headerStyle.columnGap) || 0;
  const titleWidth = title ? oneLineWidth(title, scale) : 0;
  return (
    (headerRect.right - row.getBoundingClientRect().left) / scale -
    parseFloat(headerStyle.paddingRight) -
    parseFloat(headerStyle.borderRightWidth) -
    titleWidth -
    endPadding -
    gap
  );
}

/**
 * Whether a header's actions show compact: always on a phone, so like actions look alike in
 * every card (one card's labels fitting while the next one's did not read as inconsistent);
 * from sm up, when with their labels they do not fit beside the title on one line. Their full
 * width is measured while they show it and kept, so showing them compact
 * does not change the answer. When something it depends on changes while they are compact
 * (compactSignature), they show full for one pass to be measured again. Every pass runs in a
 * layout effect, before paint: a resize of the header, the actions or the title only re-renders.
 */
function useCompactActionsMeasure(): {
  ref: React.RefObject<HTMLDivElement | null>;
  compact: boolean;
} {
  const ref = React.useRef<HTMLDivElement>(null);
  const [compact, setCompact] = React.useState(false);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const kept = React.useRef({ fullWidth: 0, signature: "" });

  React.useLayoutEffect(() => {
    const action = ref.current;
    const header = action?.parentElement;
    if (!action || !header) return;
    const room = roomForActions(header, action);
    if (room === null) return;
    if (!window.matchMedia("(min-width: 40rem)").matches) {
      setCompact(true);
      return;
    }
    const signature = compactSignature(header, action);
    if (!compact) {
      kept.current = { fullWidth: action.offsetWidth, signature };
      setCompact(kept.current.fullWidth > room + 0.5);
    } else if (signature !== kept.current.signature) {
      setCompact(false);
    } else {
      setCompact(kept.current.fullWidth > room + 0.5);
    }
  });

  React.useLayoutEffect(() => {
    const action = ref.current;
    const header = action?.parentElement;
    if (!action || !header || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => rerender());
    observer.observe(header);
    observer.observe(action);
    const title = header.querySelector('[data-slot="card-title"]');
    if (title) observer.observe(title);
    return () => observer.disconnect();
  }, []);

  return { ref, compact };
}
// An empty or error state fills the panel and centres in it, also when a taller card beside it
// stretches this one.
const PANEL_CLASS =
  "min-w-0 flex-1 p-4 [&:has(>[data-slot=empty])]:flex [&:has(>[data-slot=empty])]:flex-col [&:has(>[data-slot=error-state])]:flex [&:has(>[data-slot=error-state])]:flex-col";
const FOOTER_CLASS =
  "flex flex-wrap items-center justify-between gap-3 p-4 text-meta text-muted-foreground";

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
 * `stacked` (default): a 12 px hint under the title, at most 42rem wide. `inline`: a 14 px muted
 * subtitle that follows the title on its baseline.
 */
export function CardDescription({
  className,
  render,
  variant,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof descriptionVariants>): React.ReactElement {
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
  const { ref, compact } = useCompactActionsMeasure();
  const defaultProps = {
    className: cn(ACTION_CLASS, className),
    "data-slot": "card-action",
    "data-compact": compact ? "" : undefined,
  };

  const element = useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    ref,
    render,
  });
  return <CompactActionsContext.Provider value={compact}>{element}</CompactActionsContext.Provider>;
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

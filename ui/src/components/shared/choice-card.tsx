import { ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { IconChip } from "@/components/shared/icon-chip";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// The card carries the keyboard focus, so the Radio's or Checkbox's own ring is turned off: one
// ring, not two concentric ones.
const CHOICE_BASE =
  "flex min-h-11 cursor-pointer items-start gap-3 transition-colors hover:bg-accent has-data-checked:bg-accent has-data-disabled:pointer-events-none has-data-disabled:opacity-64 [&_[data-slot=checkbox]:focus-visible]:outline-none [&_[data-slot=radio]:focus-visible]:outline-none";
const CHOICE_VARIANT = {
  // A bordered card on its own; checked adds the primary edge.
  card: "rounded-lg border border-border p-3 has-data-checked:border-primary/48 has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-2 has-focus-visible:outline-solid",
  // A row divided inside a ChoiceList: no border of its own, checked is the accent fill only,
  // and the focus ring is drawn inside the row so the list's edges do not clip it.
  row: "w-full px-4 py-3 has-focus-visible:outline-1 has-focus-visible:outline-ring has-focus-visible:-outline-offset-1 has-focus-visible:outline-solid",
} as const;

/**
 * A radio or checkbox as a card: the whole card is its label. `control` is the Base UI Radio or
 * Checkbox; the card takes the accent fill while it is checked (a `card` also the primary edge),
 * and the focus outline while the control has keyboard focus. `row` is one item of a ChoiceList
 * (it renders its own `<li>`), for long lists where a border per item would be noise.
 */
export function ChoiceCard({
  control,
  title,
  description,
  children,
  variant = "card",
  className,
}: {
  control: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** More lines under the description (an id, a region). */
  children?: ReactNode;
  variant?: "card" | "row";
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const label = (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI Radio or Checkbox inside is the control.
    <label
      className={cn(CHOICE_BASE, CHOICE_VARIANT[variant], className)}
      data-slot="choice-card"
      data-variant={variant}
    >
      {/* The 16 px control sits on the title's 20 px first line. */}
      <span className="flex h-5 shrink-0 items-center">{control}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words font-medium text-foreground text-sm/5">{title}</span>
        {description ? (
          <span className="text-muted-foreground text-xs leading-normal">{description}</span>
        ) : null}
        {children}
      </span>
    </label>
  );
  return variant === "row" ? <li className="flex">{label}</li> : label;
}

const LIST_CLASS = "divide-y divide-border-subtle";

/**
 * A list of ChoiceRows, or of `ChoiceCard variant="row"` items, in one card, split by hairlines.
 * `scroll` caps it at 18rem and scrolls inside the card, fading the edge that has more rows past
 * it, so a long list shows that it goes on.
 */
export function ChoiceList({
  children,
  scroll = false,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  scroll?: boolean;
  /** Layout only. */
  className?: string;
  "aria-label"?: string;
}): JSX.Element {
  if (scroll) {
    return (
      <Card className={cn("overflow-hidden", className)} data-slot="choice-list">
        {/* A flex column, so the viewport shrinks to the cap and scrolls. */}
        <ScrollArea className="flex max-h-72 flex-col" scrollFade>
          <ul aria-label={ariaLabel} className={LIST_CLASS}>
            {children}
          </ul>
        </ScrollArea>
      </Card>
    );
  }
  return (
    <Card
      aria-label={ariaLabel}
      className={cn(LIST_CLASS, "overflow-hidden", className)}
      data-slot="choice-list"
      render={<ul />}
    >
      {children}
    </Card>
  );
}

/**
 * One row of a ChoiceList: a button that goes somewhere (the next step of a flow), with an icon
 * chip, a title, a short description and a chevron at its end.
 */
export function ChoiceRow({
  icon,
  title,
  description,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title" | "children"> & {
  icon: IconSvgElement;
  title: ReactNode;
  description?: ReactNode;
}): JSX.Element {
  return (
    <li className="group/choice-row flex">
      <button
        className={cn(
          // The end rows round with the card, so their focus outline follows its corners. 52 px
          // rows (py-2.5), so an eight-row method list fits a 768 px tall screen.
          "flex min-h-13 w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-2.5 text-start outline-none transition-[background-color,scale] hover:bg-accent focus-outline-inset active:scale-[0.99] disabled:pointer-events-none disabled:opacity-64 group-first/choice-row:rounded-t-xl group-last/choice-row:rounded-b-xl",
          className,
        )}
        type="button"
        {...props}
      >
        <IconChip icon={icon} size="md" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground text-sm">{title}</span>
          {description ? (
            <span className="text-muted-foreground text-xs leading-normal">{description}</span>
          ) : null}
        </span>
        <HugeiconsIcon
          icon={ChevronRightIcon}
          aria-hidden="true"
          className="size-4 shrink-0 text-icon-muted rtl:-scale-x-100"
        />
      </button>
    </li>
  );
}

/**
 * A choice as a tile in a grid (the Add account methods): a button with an icon chip, a title,
 * an optional badge after it and a short description. `wide` spans both columns of a
 * two-column grid, for the featured choice or the last tile of an odd row.
 */
export function ChoiceTile({
  icon,
  title,
  badge,
  description,
  wide = false,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title" | "children"> & {
  icon: IconSvgElement;
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  wide?: boolean;
}): JSX.Element {
  return (
    <button
      className={cn(
        "group/choice-tile flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-3 text-start outline-none transition-[background-color,border-color,scale] hover:border-border-strong/50 hover:bg-accent focus-outline active:scale-[0.99] disabled:pointer-events-none disabled:opacity-64",
        wide && "sm:col-span-2",
        className,
      )}
      type="button"
      {...props}
    >
      <IconChip icon={icon} size="md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground text-sm/5">{title}</span>
          {badge}
        </span>
        {description ? (
          <span className="text-muted-foreground text-xs leading-normal">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

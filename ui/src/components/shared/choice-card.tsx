import { ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ComponentProps, type JSX, type ReactNode, useId } from "react";
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
 * A radio or checkbox as a card: the whole card is its label. `control` renders the Base UI Radio
 * or Checkbox with the given id, which the label points at; the card takes the accent fill while
 * it is checked (a `card` also the primary edge), and the focus outline while the control has
 * keyboard focus. `row` is one item of a ChoiceList (it renders its own `<li>`), for long lists
 * where a border per item would be noise.
 * Inside a Base UI Field, wrap each card in a Field.Item: a Field gives every control in it the
 * field's one id, so without the item the card's id would not reach its control.
 */
export function ChoiceCard({
  control,
  title,
  description,
  children,
  variant = "card",
  className,
}: {
  control: (id: string) => ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** More lines under the description (an id, a region). */
  children?: ReactNode;
  variant?: "card" | "row";
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const controlId = useId();
  const label = (
    <label
      className={cn(CHOICE_BASE, CHOICE_VARIANT[variant], className)}
      data-slot="choice-card"
      data-variant={variant}
      htmlFor={controlId}
    >
      {/* The 16 px control sits on the title's 20 px first line. */}
      <span className="flex h-5 shrink-0 items-center">{control(controlId)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="wrap-break-word font-medium text-foreground text-sm/5">{title}</span>
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
 * it, so a long list shows that it goes on. `flush` drops the card and the hairlines: the rows sit
 * straight on the surface (a dialog), each a rounded hover area, so no box nests in another.
 */
export function ChoiceList({
  children,
  scroll = false,
  flush = false,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  scroll?: boolean;
  flush?: boolean;
  /** Layout only. */
  className?: string;
  "aria-label"?: string;
}): JSX.Element {
  if (flush) {
    return (
      // -mx-2: the rows' hover area reaches 8 px past the text column, so icons and text stay on
      // the dialog's content edge.
      <ul
        aria-label={ariaLabel}
        className={cn("-mx-2 flex flex-col gap-0.5", className)}
        data-flush=""
        data-slot="choice-list"
      >
        {children}
      </ul>
    );
  }
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
  badge,
  description,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title" | "children"> & {
  icon: IconSvgElement;
  title: ReactNode;
  /** After the title, on its line (a Recommended badge). */
  badge?: ReactNode;
  description?: ReactNode;
}): JSX.Element {
  return (
    <li className="group/choice-row flex">
      <button
        className={cn(
          // The end rows round with the card, so their focus outline follows its corners. 52 px
          // rows (py-2.5), so an eight-row method list fits a 768 px tall screen.
          "flex min-h-13 w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-2.5 text-start transition-[background-color,scale] hover:bg-accent focus-outline-inset active:scale-[0.99] disabled:pointer-events-none disabled:opacity-64 group-first/choice-row:rounded-t-xl group-last/choice-row:rounded-b-xl",
          // In a flush list: a rounded hover area with the icon bare, no chip and no card.
          "in-data-flush:rounded-lg in-data-flush:px-2 in-data-flush:group-first/choice-row:rounded-lg in-data-flush:group-last/choice-row:rounded-lg",
          className,
        )}
        type="button"
        {...props}
      >
        <IconChip className="in-data-flush:hidden" icon={icon} size="md" />
        <span className="hidden size-9 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover/choice-row:text-foreground in-data-flush:flex">
          <HugeiconsIcon aria-hidden="true" className="size-4" icon={icon} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground text-sm">{title}</span>
            {badge}
          </span>
          {description ? (
            <span className="text-muted-foreground text-xs leading-normal">{description}</span>
          ) : null}
        </span>
        <HugeiconsIcon
          icon={ChevronRightIcon}
          aria-hidden="true"
          className="size-4 shrink-0 text-icon-muted transition-[translate,color] group-hover/choice-row:translate-x-0.5 group-hover/choice-row:text-foreground rtl:-scale-x-100 rtl:group-hover/choice-row:-translate-x-0.5"
        />
      </button>
    </li>
  );
}

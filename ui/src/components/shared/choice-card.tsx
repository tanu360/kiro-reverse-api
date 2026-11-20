import { type JSX, type ReactNode, useId } from "react";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, placeholderKeys } from "@/lib/utils";

// The card carries the keyboard focus, so the Radio's or Checkbox's own ring is turned off: one
// ring, not two concentric ones.
const CHOICE_BASE =
  "flex min-h-11 cursor-pointer items-start gap-3 transition-colors hover:bg-accent has-data-checked:bg-accent has-data-disabled:pointer-events-none has-data-disabled:opacity-64 [&_[data-slot=checkbox]:focus-visible]:outline-none [&_[data-slot=radio]:focus-visible]:outline-none";
const CHOICE_VARIANT = {
  // A bordered card on its own; checked adds the muted ring-grey edge.
  card: "rounded-lg border border-border p-3 has-data-checked:border-ring has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-2 has-focus-visible:outline-solid",
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
 * A scrolling ChoiceList while its items load: rows of the same padding, each a checkbox and a
 * title bar (and a description bar with `description`), in the skeleton tint like every other
 * loading state. `label` is read to screen readers.
 */
export function ChoiceListSkeleton({
  label,
  rows = 4,
  description = false,
}: {
  label: string;
  rows?: number;
  /** The rows carry a second line (an account's plan and region). */
  description?: boolean;
}): JSX.Element {
  return (
    <Card aria-busy="true" className="overflow-hidden" data-slot="choice-list" role="status">
      <span className="sr-only">{label}</span>
      <ul aria-hidden="true" className={LIST_CLASS}>
        {placeholderKeys("choice", rows).map((row, index) => (
          <li className="flex min-h-11 items-start gap-3 px-4 py-3" key={row}>
            {/* The 16 px control on the title's 20 px first line, as ChoiceCard. */}
            <span className="flex h-5 shrink-0 items-center">
              <Skeleton className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
              <Skeleton className={cn("h-4", index % 2 === 0 ? "w-2/5" : "w-1/3")} />
              {description ? <Skeleton className="h-3 w-1/4" /> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

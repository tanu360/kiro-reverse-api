import { ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { IconChip } from "@/components/shared/icon-chip";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A radio or checkbox as a card: the whole card is its label. `control` is the Base UI Radio or
 * Checkbox; the card takes the primary edge and the accent fill while it is checked, and the
 * focus outline while the control has keyboard focus.
 */
export function ChoiceCard({
  control,
  title,
  description,
  children,
  className,
}: {
  control: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** More lines under the description (an id, a region). */
  children?: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI Radio or Checkbox inside is the control.
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent has-data-checked:border-primary/48 has-data-checked:bg-accent has-data-disabled:pointer-events-none has-data-disabled:opacity-64 has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-2 has-focus-visible:outline-solid",
        className,
      )}
      data-slot="choice-card"
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
}

/** A list of ChoiceRows in one card, split by hairlines. */
export function ChoiceList({
  children,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  /** Layout only. */
  className?: string;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <Card
      aria-label={ariaLabel}
      className={cn("divide-y divide-border-subtle overflow-hidden", className)}
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
          // The end rows round with the card, so their focus outline follows its corners.
          "flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-start outline-none transition-[background-color,scale] hover:bg-accent focus-outline-inset active:scale-[0.99] disabled:pointer-events-none disabled:opacity-64 group-first/choice-row:rounded-t-xl group-last/choice-row:rounded-b-xl",
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

import { CheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The one dropdown row, taken from the sign-in language picker: single line, 32 px (40 px on
 * touch screens), 8 px side padding, a 6 px corner, 14 px text and a 10 px gap
 * between an icon and the label. The highlighted row takes the accent tone; the chosen row of a
 * select (data-selected) or a radio or checkbox menu (data-checked) turns the accent text colour
 * and ends in a CheckedDot. Selects, menus, comboboxes, autocompletes and the command menu all
 * use it, on the popup-surface sheet (index.css).
 */
export const POPUP_ROW_CLASS =
  "flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-foreground text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-checked:text-info-foreground data-selected:text-info-foreground data-disabled:opacity-64 pointer-coarse:min-h-10 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

/** A row that can be chosen: room at the end for the CheckedDot. */
export const POPUP_CHECK_ROW_CLASS = "pe-2.5";

/** Where the CheckedDot sits: pushed to the row's end, 12 px clear of the label. */
export const POPUP_INDICATOR_CLASS = "ms-auto ps-3";

/** A muted group heading over a run of rows, its text lined up with theirs. */
export const POPUP_GROUP_LABEL_CLASS = "px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs";

/** A hairline across the whole popup, in the popup's own border colour. */
export const POPUP_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-popup-border";

/** Muted trailing text on a row (a count, a shortcut), before the CheckedDot. */
export const POPUP_ROW_META_CLASS = "ms-auto ps-4 text-muted-foreground text-xs";

/** The chosen row's mark: a white check in a filled Kiro-purple circle. */
export function CheckedDot({ className }: { className?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        "grid size-4.5 place-items-center rounded-full bg-primary text-primary-foreground",
        className,
      )}
      data-slot="checked-dot"
    >
      <HugeiconsIcon icon={CheckIcon} aria-hidden="true" className="size-3" strokeWidth={3} />
    </span>
  );
}

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX } from "react";

/**
 * A sheet header's mark on the account sheet's avatar tile: 40 px, a soft border on the chip
 * surface, the icon muted. Decorative; the title beside it names the sheet.
 */
export function SheetMark({ icon }: { icon: IconSvgElement }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-2"
    >
      <HugeiconsIcon className="size-5 text-muted-foreground" icon={icon} />
    </span>
  );
}

import { InfoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * `label`: a label followed by an info icon. It sits in the text's own line box (inherited
 * line height, baseline-aligned), so a hinted term lines up with the plain ones beside it. It
 * opens on hover, click and tap, as a tooltip-styled note.
 * `link`: the dotted-underline "Learn more" in a hint line (the Settings look), an info icon
 * and the label. It opens on click or tap only, as a popover for longer notes.
 * Both get a 44 px hit area on touch screens and stay focusable.
 */
const TRIGGER_CLASS = {
  label:
    "touch-hit inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left align-baseline text-muted-foreground leading-[inherit] outline-none transition-colors hover:text-foreground focus-outline data-popup-open:text-foreground",
  link: "touch-hit group/info inline-flex cursor-pointer items-baseline gap-1 whitespace-nowrap rounded-sm align-baseline text-muted-foreground outline-none transition-colors hover:text-foreground focus-outline data-popup-open:text-foreground",
} as const;

export function InfoHint({
  children,
  hint,
  variant = "label",
  truncate = false,
  className,
}: {
  /** The visible label; it is also the trigger's accessible name. */
  children: ReactNode;
  hint: ReactNode;
  variant?: "label" | "link";
  /**
   * `label` only: keep the label on one line, cut with an ellipsis, instead of wrapping to two.
   * For a row of tiles whose label rows must stay the same height (StatTile).
   */
  truncate?: boolean;
  className?: string;
}): JSX.Element {
  const link = variant === "link";
  return (
    <Popover>
      <PopoverTrigger
        className={cn(TRIGGER_CLASS[variant], truncate && !link && "min-w-0", className)}
        closeDelay={200}
        data-slot="info-hint"
        data-variant={variant}
        delay={200}
        openOnHover={!link}
      >
        {link ? (
          <>
            <HugeiconsIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 self-center"
              icon={InfoIcon}
            />
            <span className="underline decoration-dotted underline-offset-3 group-hover/info:decoration-solid group-data-popup-open/info:decoration-solid">
              {children}
            </span>
          </>
        ) : (
          <>
            <span className={truncate ? "min-w-0 truncate" : "line-clamp-2 text-pretty"}>
              {children}
            </span>
            <HugeiconsIcon aria-hidden="true" className="size-3.5 shrink-0" icon={InfoIcon} />
          </>
        )}
      </PopoverTrigger>
      {link ? (
        <PopoverPopup className="max-w-xs">{hint}</PopoverPopup>
      ) : (
        <PopoverPopup className="max-w-72" side="top" tooltipStyle>
          {hint}
        </PopoverPopup>
      )}
    </Popover>
  );
}

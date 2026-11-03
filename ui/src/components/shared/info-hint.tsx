import { InfoIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A label with an info icon that explains itself in a small popup. Unlike a tooltip it opens on
 * tap and on click (and still on hover), so touch users can read the explanation. On touch
 * screens the trigger gets a 44 px tall hit area.
 */
export function InfoHint({
  children,
  hint,
  className,
}: {
  /** The visible label; it is also the trigger's accessible name. */
  children: ReactNode;
  hint: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "relative inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground",
          "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-y-1/2",
          className,
        )}
        closeDelay={100}
        delay={300}
        openOnHover
      >
        <span className="truncate">{children}</span>
        <InfoIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </PopoverTrigger>
      <PopoverPopup className="max-w-72" side="top" tooltipStyle>
        {hint}
      </PopoverPopup>
    </Popover>
  );
}

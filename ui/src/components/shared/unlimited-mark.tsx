import { Infinity01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Unlimited" as the infinity sign, for a limit that is not set: one glyph in every language that
 * sits beside numbers ("1.9M / ∞") without widening a column. The word stays for screen readers
 * and in a tooltip. The 14 px sign centres on the digits' cap height at any text size: the mark is
 * a 1cap-tall box standing on the baseline with the sign centred over it. Its first try, an
 * inline-flex dropped 0.2em, sat 1 px high on macOS.
 */
export function UnlimitedMark({ className }: { className?: string }): JSX.Element {
  const { t } = useT();
  const label = t("unlimited");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("relative inline-block h-[1cap] w-3.5 align-baseline", className)}
            data-slot="unlimited"
          />
        }
      >
        <HugeiconsIcon
          aria-hidden="true"
          className="absolute start-0 top-1/2 size-3.5 -translate-y-1/2"
          icon={Infinity01Icon}
          strokeWidth={2}
        />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

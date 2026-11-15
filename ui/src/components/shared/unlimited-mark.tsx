import { Infinity01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Unlimited" as the infinity sign, for a limit that is not set: one glyph in every language that
 * sits beside numbers ("1.9M / ∞") without widening a column. The word stays for screen readers
 * and in a tooltip. The sign is 14 px and drops a fifth of an em, so it centres on 12 and 14 px
 * text.
 */
export function UnlimitedMark({ className }: { className?: string }): JSX.Element {
  const { t } = useT();
  const label = t("unlimited");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("inline-flex items-center align-[-0.2em]", className)}
            data-slot="unlimited"
          />
        }
      >
        <HugeiconsIcon
          aria-hidden="true"
          className="size-3.5"
          icon={Infinity01Icon}
          strokeWidth={2}
        />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

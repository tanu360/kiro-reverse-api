import { CircleArrowUp02Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";

/**
 * Header button that stays while a newer release is known, so the notice outlives its toast
 * on phones (sidebar sheet closed) and with the icon rail. It opens the update dialog.
 */
export function UpdateIndicator(): JSX.Element | null {
  const { t } = useT();
  const { latest, openDialog } = useUpdateCheck();
  if (!latest) return null;
  const label = t("shell.update.available", { latest: stripV(latest.version) });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="relative text-warning-foreground"
            data-slot="update-indicator"
            onClick={openDialog}
            size="icon"
            variant="quiet"
          />
        }
      >
        <AnimatedIcon icon={CircleArrowUp02Icon} aria-hidden="true" />
        {/* On the glyph's top corner at each button size (36 / 32 px, 40 on touch). */}
        <UpdateDot className="top-1.5 right-1.5 sm:top-1 sm:right-1 pointer-coarse:top-2 pointer-coarse:right-2" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

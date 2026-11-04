import { CircleArrowUpIcon } from "lucide-react";
import type { JSX } from "react";
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
            className="relative size-10 text-warning-foreground md:size-8 [:hover,[data-pressed]]:text-warning-foreground"
            data-slot="update-indicator"
            onClick={openDialog}
            size="icon"
            variant="quiet"
          />
        }
      >
        <CircleArrowUpIcon aria-hidden="true" />
        <UpdateDot className="top-2 right-2 md:top-1 md:right-1" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

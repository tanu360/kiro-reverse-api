import { EyeIcon, EyeOffIcon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { usePrivacy } from "@/lib/privacy";
import { HEADER_ICON_BUTTON } from "./header-button";

export function PrivacyToggle(): JSX.Element {
  const { t } = useT();
  const { enabled, toggle } = usePrivacy();
  const Icon = enabled ? EyeOffIcon : EyeIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={t("shell.privacy.label")}
            aria-pressed={enabled}
            className={HEADER_ICON_BUTTON}
            onClick={toggle}
            size="icon"
            variant="quiet"
          />
        }
      >
        <AnimatedIcon icon={Icon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{t("shell.privacy.tooltip")}</TooltipPopup>
    </Tooltip>
  );
}

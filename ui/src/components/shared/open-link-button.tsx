import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Opens an address in a new tab: CopyButton's twin, so an open and a copy icon side by side
 * share one size, hover and icon motion. Icon-only, with `label` as its accessible name and
 * tooltip; the touch sizes come from the Button's icon sizes. It is a real link (`<a>`), so
 * a middle click or the context menu work as on any link.
 */
export function OpenLinkButton({
  href,
  label,
  variant = "ghost",
  size = "icon",
  className,
}: {
  href: string;
  label: string;
  variant?: "ghost" | "quiet" | "outline" | "secondary";
  size?: "icon" | "icon-sm" | "icon-xs";
  className?: string;
}): JSX.Element {
  const button = (
    <Button
      aria-label={label}
      className={className}
      render={<a href={href} rel="noopener noreferrer" target="_blank" />}
      size={size}
      variant={variant}
    >
      <AnimatedIcon icon={ExternalLinkIcon} aria-hidden="true" />
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

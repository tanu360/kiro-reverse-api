import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/*
 * A one-line notice (an inline error, the new-key bar): an Alert with a plain line of text and
 * bare icon actions. The icon, the text's first line and the actions share one 20 px line: the
 * actions' extra height goes into negative margins, so they never push the text off the icon,
 * and on a phone they stay beside the text instead of dropping under it.
 */

/** On the Alert. */
export const NOTICE_LINE_CLASS = "sm:has-data-[slot=alert-action]:py-2";

/** On its AlertAction. */
export const NOTICE_ACTIONS_CLASS =
  "-my-1 gap-0 self-start max-sm:col-start-3 max-sm:row-start-1 max-sm:-mt-1 sm:-my-1.5 sm:pointer-coarse:-my-2";

/**
 * The notice built from the pieces above: the tone's icon, the line, then its actions. Other
 * props (variant, role, data-slot, ref) go to the Alert.
 */
export function NoticeLine({
  icon,
  actions,
  children,
  className,
  ...props
}: ComponentProps<typeof Alert> & {
  icon: IconSvgElement;
  /** Icon-only actions after the line (NoticeIconButton, a tone-quiet CopyButton). */
  actions?: ReactNode;
}): JSX.Element {
  return (
    <Alert className={cn(NOTICE_LINE_CLASS, className)} {...props}>
      <HugeiconsIcon icon={icon} aria-hidden="true" />
      <AlertDescription className="wrap-break-word">{children}</AlertDescription>
      {actions ? <AlertAction className={NOTICE_ACTIONS_CLASS}>{actions}</AlertAction> : null}
    </Alert>
  );
}

/** An icon-only action in the notice, named by its tooltip and accessible name. */
export function NoticeIconButton({
  icon,
  label,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} onClick={onClick} size="icon-sm" variant="tone-quiet" />}
      >
        <HugeiconsIcon icon={icon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

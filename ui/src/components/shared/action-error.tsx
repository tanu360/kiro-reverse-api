import { AlertCircleIcon, Refresh01Icon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, useEffect, useRef } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** An icon-only action in the notice, named by its tooltip and accessible name. */
function NoticeIconButton({
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

/**
 * A failed action, said where it was done (a card, a form), in place of an error toast: one
 * plain line with the server's reason (the place says what failed), then Try again and close as
 * bare icons, kept beside the text on a phone too. Its alert role reads it out at once; each new
 * failure scrolls it into view.
 */
export function ActionError({
  error,
  onRetry,
  onDismiss,
  className,
}: {
  error: unknown;
  /** Runs the same action again. */
  onRetry?: () => void;
  /** Closes the notice; without it (a form's error) it stays until the next try. */
  onDismiss?: () => void;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);

  // A failure in a row far down a long list: bring the notice into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per new failure.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);

  return (
    // The icon, the text's first line and the icon buttons share one 20 px line: the buttons'
    // extra height goes into negative margins, so they never push the text off the icon.
    <Alert
      className={cn("sm:has-data-[slot=alert-action]:py-2", className)}
      data-slot="action-error"
      ref={ref}
      variant="error"
    >
      <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
      <AlertDescription className="wrap-break-word">{errorMessage(error, t)}</AlertDescription>
      {onRetry || onDismiss ? (
        <AlertAction className="-my-1 gap-0 self-start max-sm:col-start-3 max-sm:row-start-1 max-sm:-mt-1 sm:-my-1.5 sm:pointer-coarse:-my-2">
          {onRetry ? (
            <NoticeIconButton icon={Refresh01Icon} label={t("actions.retry")} onClick={onRetry} />
          ) : null}
          {onDismiss ? (
            <NoticeIconButton icon={XIcon} label={t("actions.close")} onClick={onDismiss} />
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}

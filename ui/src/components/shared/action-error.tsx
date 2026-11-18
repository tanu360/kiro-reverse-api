import { AlertCircleIcon, Refresh01Icon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useRef } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NOTICE_ACTIONS_CLASS, NOTICE_LINE_CLASS, NoticeIconButton } from "./notice-line";

/**
 * A failed action, said where it was done (a card, a form), in place of an error toast: one
 * plain line with the server's reason (the place says what failed), then Try again and close as
 * bare icons, kept beside the text on a phone too. Its alert role reads it out at once; each new
 * failure scrolls it into view.
 */
export function ActionError({
  error,
  message,
  onRetry,
  onDismiss,
  className,
}: {
  error: unknown;
  /** The line in place of the error's own reason, when the place words it (a batch's failures). */
  message?: string;
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
    <Alert
      className={cn(NOTICE_LINE_CLASS, className)}
      data-slot="action-error"
      ref={ref}
      variant="error"
    >
      <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
      <AlertDescription className="wrap-break-word">
        {message ?? errorMessage(error, t)}
      </AlertDescription>
      {onRetry || onDismiss ? (
        <AlertAction className={NOTICE_ACTIONS_CLASS}>
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

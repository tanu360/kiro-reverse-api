import { AlertCircleIcon, Refresh01Icon, XIcon } from "@hugeicons/core-free-icons";
import { type JSX, useEffect, useRef } from "react";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { NoticeIconButton, NoticeLine } from "./notice-line";

/**
 * A failed action, said where it was done (a card, a form): one plain line with the server's
 * reason (the place says what failed), then Try again and close as bare icons, kept beside the
 * text on a phone too. Its alert role reads it out at once; each new failure scrolls it into view.
 */
export function ActionError({
  error,
  message,
  onRetry,
  onDismiss,
  className,
}: {
  /** What failed: a thrown value (its server reason is shown), or a line the page wrote itself. */
  error: unknown;
  /**
   * The line in place of the error's own reason, when the place words the failure itself (a
   * batch's result, a feature's own error codes).
   */
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
  }, [error, message]);

  return (
    <NoticeLine
      actions={
        onRetry || onDismiss ? (
          <>
            {onRetry ? (
              <NoticeIconButton icon={Refresh01Icon} label={t("actions.retry")} onClick={onRetry} />
            ) : null}
            {onDismiss ? (
              <NoticeIconButton icon={XIcon} label={t("actions.close")} onClick={onDismiss} />
            ) : null}
          </>
        ) : null
      }
      className={className}
      data-slot="action-error"
      icon={AlertCircleIcon}
      ref={ref}
      variant="error"
    >
      {message ?? (typeof error === "string" ? error : errorMessage(error, t))}
    </NoticeLine>
  );
}

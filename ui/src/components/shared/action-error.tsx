import { AlertCircleIcon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useRef } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";

/**
 * A failed action, said where it was done (a card, a row's card), in place of an error toast:
 * what failed as the title, the server's reason under it, Try again and a close button. Its
 * alert role reads it out at once; each new failure scrolls it into view.
 */
export function ActionError({
  title,
  error,
  onRetry,
  onDismiss,
  className,
}: {
  title: string;
  error: unknown;
  /** Runs the same action again; without it there is only the close button. */
  onRetry?: () => void;
  onDismiss: () => void;
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
    <Alert className={className} data-slot="action-error" ref={ref} variant="error">
      <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
      <AlertTitle className="wrap-break-word">{title}</AlertTitle>
      <AlertDescription className="wrap-break-word">{errorMessage(error, t)}</AlertDescription>
      <AlertAction>
        {onRetry ? (
          <Button onClick={onRetry} size="sm" variant="tone">
            {t("actions.retry")}
          </Button>
        ) : null}
        <Button
          aria-label={t("actions.close")}
          className="border-transparent"
          onClick={onDismiss}
          size="icon-sm"
          variant="tone"
        >
          <HugeiconsIcon icon={XIcon} aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
}

import { AlertCircleIcon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function ErrorState({
  title,
  error,
  onRetry,
  compact = false,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  compact?: boolean;
}): JSX.Element {
  const { t } = useT();
  const message = error === undefined ? null : errorMessage(error, t);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-3 text-balance text-center",
        compact ? "px-4 py-6" : "px-6 py-12 md:py-16",
      )}
      role="alert"
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        aria-hidden="true"
        className="size-5 text-destructive-foreground"
      />
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-semibold text-heading">{title ?? t("state.errorTitle")}</p>
        {message ? (
          <p className="break-words text-muted-foreground text-sm leading-relaxed">{message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button onClick={onRetry} variant="outline">
          <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
          {t("actions.retry")}
        </Button>
      ) : null}
    </div>
  );
}

import { AlertCircleIcon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { EMPTY_SIZING } from "./empty-state";

/**
 * A failed load, drawn as the empty state's sibling: the same layout and sizes with a red icon
 * tile, the reason under the title and an optional Retry (with a spinner while `retrying`).
 * `notLoaded` is the quiet form for a card under a page-level error banner: a muted
 * "Not loaded" line, no icon and no Retry (the banner has it).
 */
export function ErrorState({
  title,
  error,
  onRetry,
  retrying = false,
  compact = false,
  notLoaded = false,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  /** The retry is running: Retry shows a spinner and ignores clicks. */
  retrying?: boolean;
  compact?: boolean;
  notLoaded?: boolean;
}): JSX.Element {
  const { t } = useT();

  if (notLoaded) {
    return (
      <div
        className="flex min-w-0 items-center justify-center px-4 py-6 text-center text-meta text-muted-foreground"
        data-slot="error-state"
        data-state="not-loaded"
        role="status"
      >
        {title ?? t("state.notLoaded")}
      </div>
    );
  }

  const message = error === undefined ? null : errorMessage(error, t);
  const sizing = EMPTY_SIZING[compact ? "compact" : "default"];
  return (
    <Empty className={sizing.root} data-slot="error-state" role="alert">
      <EmptyHeader>
        <EmptyMedia className={sizing.media} tone="destructive" variant="icon">
          <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title ?? t("state.errorTitle")}</EmptyTitle>
        {message ? <EmptyDescription className="break-words">{message}</EmptyDescription> : null}
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button
            loading={retrying}
            onClick={() => {
              if (!retrying) onRetry();
            }}
            size={compact ? "sm" : "default"}
            variant="outline"
          >
            <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
            {t("actions.retry")}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

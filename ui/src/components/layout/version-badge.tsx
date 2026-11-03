import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { versionQuery } from "@/lib/api/system";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";

/**
 * Shows the running version. Clicking it runs a manual update check; a dot marks a newer
 * release found by the silent check.
 */
export function VersionBadge({ className }: { className?: string }): JSX.Element {
  const { t } = useT();
  const { data } = useQuery(versionQuery());
  const { latest, checking, checkNow, openDialog } = useUpdateCheck();
  const version = data?.version ? `v${stripV(data.version)}` : "—";
  const hasUpdate = latest !== null;
  const tooltip = hasUpdate
    ? t("shell.update.available", { latest: stripV(latest.version) })
    : checking
      ? t("shell.update.checking")
      : t("shell.update.check");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-busy={checking || undefined}
            aria-label={`${t("shell.version.current")}: ${version}. ${tooltip}`}
            className={cn(
              "relative inline-flex h-6 items-center gap-1.5 rounded-md border bg-background px-2 font-mono text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64",
              className,
            )}
            disabled={checking}
            onClick={hasUpdate ? openDialog : checkNow}
            type="button"
          />
        }
      >
        {checking ? <Spinner aria-hidden="true" className="size-3" /> : null}
        <span>{version}</span>
        {hasUpdate ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 size-2 rounded-full bg-warning ring-2 ring-sidebar"
            data-slot="update-dot"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

import { ExternalLinkIcon } from "lucide-react";
import type { JSX } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Button } from "@/components/ui/button";
import type { RemoteVersionJson } from "@/lib/api/types";
import { useT } from "@/lib/i18n";

/** "v2.1.0" and "2.1.0" both display as "2.1.0"; the UI adds its own "v". */
export function stripV(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function UpdateDialog({
  open,
  onOpenChange,
  current,
  latest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  latest: RemoteVersionJson | null;
}): JSX.Element {
  const { t } = useT();
  const download = latest?.download ?? "";
  // Only an https release link is offered; anything else in the remote file is ignored.
  const releaseUrl = download.startsWith("https://") ? download : null;
  const changelog = latest?.changelog?.trim();

  return (
    <ResponsiveDialog
      description={t("shell.update.newVersionMessage")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("actions.close")}
          </Button>
          {releaseUrl ? (
            <Button render={<a href={releaseUrl} rel="noopener noreferrer" target="_blank" />}>
              {t("shell.update.viewRelease")}
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
          ) : null}
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title={t("shell.update.title")}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border bg-muted/40 p-3">
            <p className="text-muted-foreground text-xs">{t("shell.update.current")}</p>
            <p className="font-medium font-mono text-lg tabular-nums">
              {current ? `v${stripV(current)}` : "—"}
            </p>
          </div>
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="text-muted-foreground text-xs">{t("shell.update.latest")}</p>
            <p className="font-medium font-mono text-lg tabular-nums">
              {latest ? `v${stripV(latest.version)}` : "—"}
            </p>
          </div>
        </div>
        {changelog ? (
          <div className="flex flex-col gap-1.5">
            <p className="font-medium text-sm">{t("shell.update.changelog")}</p>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-sm">
              {changelog}
            </p>
          </div>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

import { Copy01Icon, Download01Icon, FileBracesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useId, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { exportAccounts } from "@/lib/api/accounts";
import type { Account, ExportData } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { saveJson } from "@/lib/download";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast, toastError } from "@/lib/toast";
import { authLabel, buildExportCopy, exportFilename, subscriptionLabel } from "./account-model";

/**
 * Exports the chosen accounts (the list filter does not apply). The JSON holds live secrets:
 * it is never logged or cached, and lives only in this dialog's state while it is shown.
 */
export function ExportDialog({
  accounts,
  open,
  onOpenChange,
}: {
  accounts: Account[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const displayEmail = useDisplayEmail();
  const jsonId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState<"show" | "copy" | "download" | null>(null);
  const jsonRef = useRef<HTMLTextAreaElement | null>(null);
  const hasJson = json !== null;

  // The JSON renders under the account list, below the fold on phones: bring it into view and
  // focus it, so the tap on Show JSON visibly does something and the text is ready to select.
  useEffect(() => {
    if (!hasJson) return;
    const field = jsonRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "nearest" });
  }, [hasJson]);

  // Every opening starts with all accounts selected and no JSON on screen.
  // Only on open: a refetch while the dialog is open keeps the user's choice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when `open` changes only.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(accounts.map((account) => account.id)));
    setJson(null);
  }, [open]);

  const allSelected = accounts.length > 0 && selected.size === accounts.length;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedIds = () => accounts.filter((a) => selected.has(a.id)).map((a) => a.id);

  /** Fetches the export, or warns when nothing is selected. Server errors toast. */
  const fetchExport = async (): Promise<ExportData | null> => {
    const ids = selectedIds();
    if (ids.length === 0) {
      toast.warning(t("export.noSelection"));
      return null;
    }
    try {
      return await exportAccounts(ids);
    } catch (error) {
      toastError(error, t);
      return null;
    }
  };

  const withBusy = async (kind: "show" | "copy" | "download", task: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };

  const onShow = () =>
    withBusy("show", async () => {
      const data = await fetchExport();
      if (data) setJson(JSON.stringify(data, null, 2));
    });

  const onCopy = () => {
    const ids = selectedIds();
    if (ids.length === 0) {
      toast.warning(t("export.noSelection"));
      return;
    }
    let failure: unknown = null;
    // The promise goes to copyText at once, so Safari keeps the click's user activation.
    const text = exportAccounts(ids).then(
      (data) => JSON.stringify(buildExportCopy(data), null, 2),
      (error: unknown) => {
        failure = error;
        throw error;
      },
    );
    void withBusy("copy", async () => {
      const ok = await copyText(text);
      if (ok) toast.success(t("export.copied"));
      else if (failure) toastError(failure, t);
      else toast.error(tc("toast.copyFailed"));
    });
  };

  const onDownload = () =>
    withBusy("download", async () => {
      const data = await fetchExport();
      if (data) saveJson(data, exportFilename());
    });

  return (
    <ResponsiveDialog
      description={t("export.description")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.cancel")}
          </Button>
          {/* One row in the stacked phone footer; `contents` keeps the desktop row as it was. */}
          <div className="flex gap-2 max-sm:*:flex-1 sm:contents">
            <Button
              loading={busy === "show"}
              disabled={busy !== null}
              onClick={() => void onShow()}
              variant="outline"
            >
              <HugeiconsIcon icon={FileBracesIcon} aria-hidden="true" />
              {t("export.showJson")}
            </Button>
            <Button
              loading={busy === "copy"}
              disabled={busy !== null}
              onClick={onCopy}
              variant="outline"
            >
              <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
              {t("export.copyJson")}
            </Button>
          </div>
          <Button
            loading={busy === "download"}
            disabled={busy !== null}
            onClick={() => void onDownload()}
          >
            <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
            {t("export.downloadJson")}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="lg"
      title={t("export.title")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {t("export.selected", { count: selected.size })}
          </p>
          <Button
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(accounts.map((account) => account.id)))
            }
            className="max-sm:h-10"
            size="sm"
            variant="outline"
          >
            {allSelected ? t("export.deselectAll") : t("export.selectAll")}
          </Button>
        </div>
        <ul
          aria-label={t("export.list")}
          className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60"
        >
          {accounts.map((account) => {
            const email = displayEmail(account.email, account.id);
            return (
              <li key={account.id}>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI control inside is the input. */}
                <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 has-data-checked:bg-accent/40">
                  <Checkbox
                    checked={selected.has(account.id)}
                    onCheckedChange={() => toggle(account.id)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-sm">{email}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {authLabel(account, t)} · {subscriptionLabel(account.subscriptionType, t)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {json !== null ? (
          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm" htmlFor={jsonId}>
              {t("export.json")}
            </label>
            <Textarea
              className="font-mono text-xs"
              id={jsonId}
              readOnly
              ref={jsonRef}
              rows={12}
              value={json}
            />
          </div>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

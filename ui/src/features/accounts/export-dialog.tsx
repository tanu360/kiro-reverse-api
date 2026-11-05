import {
  Copy01Icon,
  Download01Icon,
  FileBracesIcon,
  ListViewIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { exportAccounts } from "@/lib/api/accounts";
import type { Account, ExportData } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { saveJson } from "@/lib/download";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { accountMeta, useAccountName } from "./account-cells";
import { buildExportCopy, exportFilename, filterAccounts } from "./account-model";

/**
 * Exports the chosen accounts (the list filter does not apply). The JSON holds live secrets:
 * it is never logged or cached, and lives only in this dialog's state while it is shown.
 */
export function ExportDialog({
  accounts,
  open,
  onOpenChange,
  initialSelection,
}: {
  accounts: Account[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The ids checked when the dialog opens (the list's selection); every account without it. */
  initialSelection?: readonly string[];
}): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const accountName = useAccountName();
  const jsonId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [busy, setBusy] = useState<"show" | "copy" | "download" | null>(null);
  const jsonRef = useRef<HTMLTextAreaElement | null>(null);
  const jsonShown = showJson && json !== null;

  // The JSON takes the list's place: focus it, so it is ready to select (and in view on phones).
  useEffect(() => {
    if (!jsonShown) return;
    const field = jsonRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "nearest" });
  }, [jsonShown]);

  // Every opening starts from its selection (or all accounts), the full list and no JSON.
  // Only on open: a refetch while the dialog is open keeps the user's choice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when `open` changes only.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(initialSelection ?? accounts.map((account) => account.id)));
    setQuery("");
    setJson(null);
    setShowJson(false);
  }, [open]);

  // The search narrows the list by email or nickname; the selection keeps hidden rows.
  const visible = useMemo(
    () => (query.trim() ? filterAccounts(accounts, { q: query }, 0) : accounts),
    [accounts, query],
  );
  const visibleSelected = visible.filter((account) => selected.has(account.id)).length;
  const allVisible = visible.length > 0 && visibleSelected === visible.length;
  const someVisible = visibleSelected > 0 && !allVisible;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleVisible = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const account of visible) {
        if (allVisible) next.delete(account.id);
        else next.add(account.id);
      }
      return next;
    });

  const selectedIds = () => accounts.filter((a) => selected.has(a.id)).map((a) => a.id);
  const selectedCount = selectedIds().length;

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

  // Show JSON fetches the selection and swaps the list for it; the same button goes back.
  const onToggleJson = () => {
    if (jsonShown) {
      setShowJson(false);
      return;
    }
    void withBusy("show", async () => {
      const data = await fetchExport();
      if (!data) return;
      setJson(JSON.stringify(data, null, 2));
      setShowJson(true);
    });
  };

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
          <Button
            disabled={busy !== null && busy !== "show"}
            loading={busy === "show"}
            onClick={onToggleJson}
            variant="outline"
          >
            <HugeiconsIcon icon={jsonShown ? ListViewIcon : FileBracesIcon} aria-hidden="true" />
            {jsonShown ? t("export.showList") : t("export.showJson")}
          </Button>
          <Button
            disabled={busy !== null && busy !== "copy"}
            loading={busy === "copy"}
            onClick={onCopy}
            variant="outline"
          >
            <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
            {t("export.copyJson")}
          </Button>
          <Button
            disabled={busy !== null && busy !== "download"}
            loading={busy === "download"}
            onClick={() => void onDownload()}
          >
            <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
            {t("export.downloadJson")}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="xl"
      title={t("export.title")}
    >
      {jsonShown ? (
        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm/5" htmlFor={jsonId}>
            {t("export.json")}
          </label>
          <Textarea
            id={jsonId}
            readOnly
            ref={jsonRef}
            rows={12}
            value={json ?? ""}
            variant="mono"
            wrap="off"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <InputGroup>
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("export.search")}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("export.search")}
              type="search"
              value={query}
            />
          </InputGroup>
          <div className="flex items-center justify-between gap-3">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI Checkbox inside is the control. */}
            <label className="flex cursor-pointer items-center gap-3 font-medium text-sm/5">
              <Checkbox
                checked={allVisible}
                disabled={visible.length === 0}
                indeterminate={someVisible}
                onCheckedChange={toggleVisible}
              />
              {allVisible ? t("export.deselectAll") : t("export.selectAll")}
            </label>
            <p aria-live="polite" className="text-meta text-muted-foreground tabular-nums">
              {t("export.selected", { count: selectedCount })}
            </p>
          </div>
          <ul
            aria-label={t("export.list")}
            className="scrollbar-y flex max-h-72 flex-col gap-2 overflow-y-auto"
          >
            {visible.map((account) => {
              const name = accountName(account);
              return (
                <li key={account.id}>
                  <ChoiceCard
                    control={
                      <Checkbox
                        checked={selected.has(account.id)}
                        onCheckedChange={() => toggle(account.id)}
                      />
                    }
                    description={accountMeta(account, t)}
                    title={
                      <span className={name.mono ? "font-mono text-meta" : undefined}>
                        {name.text}
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
          {visible.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tc("state.noMatches")}</p>
          ) : null}
        </div>
      )}
    </ResponsiveDialog>
  );
}

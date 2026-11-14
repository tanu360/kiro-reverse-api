import {
  Copy01Icon,
  Download01Icon,
  Search01Icon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useEffect, useId, useMemo, useRef, useState } from "react";
import { LoadingState } from "@/components/shared/loading-state";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { exportAccounts } from "@/lib/api/accounts";
import type { Account, ExportData } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { saveJson } from "@/lib/download";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { toast, toastError } from "@/lib/toast";
import { AuthIcon, accountMeta, StatusPill, useAccountName } from "./account-cells";
import {
  accountStatus,
  buildExportCopy,
  exportFilename,
  filterAccounts,
  STATUS_GROUPS,
  type StatusGroup,
  statusGroup,
} from "./account-model";

type ExportView = "list" | "json";
type QuickGroup = "all" | StatusGroup;
const QUICK_GROUPS: readonly QuickGroup[] = ["all", ...STATUS_GROUPS];

/** Keys whose string values are sign-in secrets: the preview masks them until revealed. */
const SECRET_KEY = /(token|secret|password|apikey|api_key|cookie)$/i;

/** A secret as its first and last four characters, so two keys still tell apart. */
function maskSecret(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "••••••••";
}

/** The export with every secret string masked, for the on-screen preview only. */
function maskSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string") return value && SECRET_KEY.test(key) ? maskSecret(value) : value;
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskSecrets(v, k)]),
    );
  }
  return value;
}

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
  const selectAllId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [json, setJson] = useState<ExportData | null>(null);
  const [reveal, setReveal] = useState(false);
  const maskText = useMaskText();
  const [view, setView] = useState<ExportView>("list");
  const [busy, setBusy] = useState<"show" | "copy" | "download" | null>(null);
  const jsonRef = useRef<HTMLTextAreaElement | null>(null);
  const jsonShown = view === "json" && json !== null;

  // The JSON takes the list's place: focus it, so it is ready to select (and in view on phones).
  useEffect(() => {
    if (!jsonShown) return;
    const field = jsonRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "nearest" });
  }, [jsonShown]);

  // Every opening starts from its selection (or all accounts), the full list and no JSON.
  // Only on open: a refetch while the dialog is open keeps the user's choice. Reset while
  // rendering, when `open` turns true, so the dialog never shows the last visit's state.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(new Set(initialSelection ?? accounts.map((account) => account.id)));
      setQuery("");
      setJson(null);
      setReveal(false);
      setView("list");
    }
  }

  // The status of every account, for the quick picks: All, Active, Needs attention, Disabled.
  const groups = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return new Map(
      accounts.map((account) => [account.id, statusGroup(accountStatus(account, now))]),
    );
  }, [accounts]);
  const groupIds = (group: QuickGroup) =>
    accounts
      .filter((account) => group === "all" || groups.get(account.id) === group)
      .map((account) => account.id);
  /** The quick pick the selection equals, if any. */
  const pickedGroup = QUICK_GROUPS.find((group) => {
    const ids = groupIds(group);
    return ids.length > 0 && ids.length === selected.size && ids.every((id) => selected.has(id));
  });

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

  // JSON fetches the selection afresh and swaps the list for it (a spinner holds its place
  // meanwhile); a failed fetch or an empty selection stays on the list. Ignored mid-request.
  const onViewChange = (next: ExportView) => {
    if (busy || next === view) return;
    if (next === "list") {
      setView("list");
      return;
    }
    if (selectedCount === 0) {
      toast.warning(t("export.noSelection"));
      return;
    }
    setJson(null);
    setView("json");
    void withBusy("show", async () => {
      const data = await fetchExport();
      if (data) setJson(data);
      else setView("list");
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

  // The preview masks secrets until revealed, and emails under privacy mode; Copy and Download
  // always carry the full export.
  const preview = useMemo(
    () => (json ? maskText(JSON.stringify(reveal ? json : maskSecrets(json), null, 2)) : ""),
    [json, reveal, maskText],
  );

  const onDownload = () =>
    withBusy("download", async () => {
      const data = await fetchExport();
      if (data) saveJson(data, exportFilename());
    });

  return (
    <ResponsiveDialog
      description={t("export.pickDescription")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.cancel")}
          </Button>
          <Button
            disabled={busy !== null && busy !== "copy"}
            loading={busy === "copy"}
            onClick={onCopy}
            variant="secondary"
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
      <Alert className="mb-3" role="note" variant="warning">
        <HugeiconsIcon icon={SquareLock02Icon} aria-hidden="true" />
        <AlertDescription>{t("export.description")}</AlertDescription>
      </Alert>
      {/* One fixed height for both views, so the dialog and its footer stay put on a switch. */}
      <div className="flex h-[26rem] flex-col gap-3 max-sm:h-[60dvh]">
        <div className="flex items-center justify-between gap-3">
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("export.view")}
                onValueChange={(next) => onViewChange(next as ExportView)}
                value={view}
              />
            }
            size="sm"
          >
            <SegmentedControlItem render={<RadioPrimitive.Root value="list" />}>
              {t("export.viewList")}
            </SegmentedControlItem>
            <SegmentedControlItem render={<RadioPrimitive.Root value="json" />}>
              {t("export.viewJson")}
            </SegmentedControlItem>
          </SegmentedControl>
          <p aria-live="polite" className="text-meta text-muted-foreground tabular-nums">
            {t("export.selected", { count: selectedCount })}
          </p>
        </div>
        {view === "json" ? (
          jsonShown ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label className="font-medium text-sm/5" htmlFor={jsonId}>
                  {t("export.json")}
                </label>
                <Label className="cursor-pointer gap-1.5 text-meta">
                  <Switch checked={reveal} onCheckedChange={setReveal} />
                  {t("export.revealCredentials")}
                </Label>
              </div>
              {/* The field fills the rest of the body; its text scrolls inside it. */}
              <Textarea
                className="min-h-0 flex-1 *:h-full *:max-h-none"
                id={jsonId}
                readOnly
                ref={jsonRef}
                value={preview}
                variant="mono"
                wrap="off"
              />
              <p className="text-meta text-muted-foreground">
                {t(reveal ? "export.previewFull" : "export.previewMasked")}
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <LoadingState />
            </div>
          )
        ) : (
          <>
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
            {/* Quick picks: each sets the selection to one status group, as the Accounts tabs split it. */}
            <fieldset
              aria-label={t("export.quickSelect")}
              className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
            >
              {QUICK_GROUPS.map((group) => {
                const count = groupIds(group).length;
                return (
                  <button
                    aria-pressed={pickedGroup === group}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 font-medium text-xs outline-none transition-colors focus-visible:focus-outline disabled:cursor-default disabled:opacity-50 aria-pressed:bg-foreground aria-pressed:text-background not-aria-pressed:text-muted-foreground not-aria-pressed:shadow-[inset_0_0_0_1px_var(--border)] not-aria-pressed:hover:bg-accent not-aria-pressed:hover:text-foreground pointer-coarse:h-8"
                    disabled={count === 0}
                    key={group}
                    onClick={() => setSelected(new Set(groupIds(group)))}
                    type="button"
                  >
                    {t(
                      group === "all"
                        ? "filter.all"
                        : group === "attention"
                          ? "filter.attention"
                          : `health.${group}`,
                    )}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </fieldset>
            {/*
              Inset like the rows below (their 16 px padding and the list's border), so its
              checkbox heads the column of row checkboxes.
            */}
            <label
              className="flex cursor-pointer items-center gap-3 self-start ps-4.25 font-medium text-sm/5"
              htmlFor={selectAllId}
            >
              <Checkbox
                checked={allVisible}
                disabled={visible.length === 0}
                id={selectAllId}
                indeterminate={someVisible}
                onCheckedChange={toggleVisible}
              />
              {/* One name in every state: checked, mixed and unchecked already say which. */}
              {t("export.selectAll")}
            </label>
            {visible.length > 0 ? (
              // Compact rows, so a long pool shows about seven at a time; the list scrolls inside
              // its border.
              <ScrollArea
                className="min-h-0 flex-1 rounded-xl border border-border-subtle"
                scrollFade
              >
                <ul aria-label={t("export.list")} className="divide-y divide-border-subtle">
                  {visible.map((account) => {
                    const name = accountName(account);
                    const id = `export-${account.id}`;
                    return (
                      <li key={account.id}>
                        <label
                          className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-(--row-hover)"
                          htmlFor={id}
                        >
                          <Checkbox
                            // Named by the account alone; the meta line and status pill follow.
                            aria-labelledby={`${id}-name`}
                            checked={selected.has(account.id)}
                            id={id}
                            onCheckedChange={() => toggle(account.id)}
                          />
                          <AuthIcon account={account} />
                          <span className="min-w-0 flex-1">
                            <span
                              id={`${id}-name`}
                              className={
                                name.mono
                                  ? "block truncate font-mono text-meta"
                                  : "block truncate font-medium text-sm/5"
                              }
                            >
                              {name.text}
                            </span>
                            <span className="block truncate text-meta text-muted-foreground">
                              {accountMeta(account, t)}
                            </span>
                          </span>
                          <StatusPill account={account} plain size="sm" />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            ) : (
              <p className="m-auto text-muted-foreground text-sm">{tc("state.noMatches")}</p>
            )}
          </>
        )}
      </div>
    </ResponsiveDialog>
  );
}

import {
  CheckIcon,
  Copy01Icon,
  Download01Icon,
  Search01Icon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { exportAccounts } from "@/lib/api/accounts";
import type { Account, ExportData } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { saveJson } from "@/lib/download";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
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

type ExportTask = "copy" | "download";
type QuickGroup = "all" | StatusGroup;
const QUICK_GROUPS: readonly QuickGroup[] = ["all", ...STATUS_GROUPS];

/**
 * One account in the pick list. Memoised: a click re-renders only the row it checks, not the
 * whole pool.
 */
const ExportRow = memo(function ExportRow({
  account,
  checked,
  onToggle,
}: {
  account: Account;
  checked: boolean;
  onToggle: (id: string) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const name = useAccountName()(account);
  const id = `export-${account.id}`;
  return (
    <li>
      <label
        className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-(--row-hover)"
        htmlFor={id}
      >
        <Checkbox
          // Named by the account alone; the meta line and status pill follow.
          aria-labelledby={`${id}-name`}
          checked={checked}
          id={id}
          onCheckedChange={() => onToggle(account.id)}
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
});

/**
 * Exports the chosen accounts (the list filter does not apply). The JSON holds live secrets:
 * it is never logged, cached or shown; it goes straight to the clipboard or a file.
 * Memoised: the page renders it on every change of its own, while it is mostly closed.
 * With nothing selected the count line asks for a selection and the actions wait;
 * Copy JSON shows a tick for two seconds; a failed request is said in the dialog, with Try again.
 */
export const ExportDialog = memo(function ExportDialog({
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
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const selectAllId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // The quick pick pressed last: of two picks with the same accounts (All and Active when every
  // account is active), the one pressed is the one shown pressed.
  const [pick, setPick] = useState<QuickGroup | null>(null);
  const [busy, setBusy] = useState<ExportTask | null>(null);
  // The last task that failed: the server's reason, or words of its own (a refused copy).
  const [failure, setFailure] = useState<{
    task: ExportTask;
    error: unknown;
    message?: string;
  } | null>(null);
  const copied = useSavedFlash();
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const downloadRef = useRef<HTMLButtonElement | null>(null);

  // Every opening starts from its selection (or all accounts) and the full list.
  // Only on open: a refetch while the dialog is open keeps the user's choice. Reset while
  // rendering, when `open` turns true, so the dialog never shows the last visit's state.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(new Set(initialSelection ?? accounts.map((account) => account.id)));
      setQuery("");
      setPick(null);
      setFailure(null);
      copied.clear();
    }
  }

  // The status of every account, for the quick picks: All, Active, Needs attention, Disabled.
  const groups = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return new Map(
      accounts.map((account) => [account.id, statusGroup(accountStatus(account, now))]),
    );
  }, [accounts]);
  // Each quick pick's ids, once per list instead of on every render and click.
  const groupIdLists = useMemo(
    () =>
      Object.fromEntries(
        QUICK_GROUPS.map((group) => [
          group,
          accounts
            .filter((account) => group === "all" || groups.get(account.id) === group)
            .map((account) => account.id),
        ]),
      ) as Record<QuickGroup, string[]>,
    [accounts, groups],
  );
  const groupIds = (group: QuickGroup) => groupIdLists[group];
  /** The quick pick the selection equals, if any. */
  const pickedGroup = useMemo(() => {
    const matches = (group: QuickGroup) => {
      const ids = groupIdLists[group];
      return ids.length > 0 && ids.length === selected.size && ids.every((id) => selected.has(id));
    };
    return pick && matches(pick) ? pick : QUICK_GROUPS.find(matches);
  }, [groupIdLists, selected, pick]);

  // The search narrows the list by email or nickname; the selection keeps hidden rows.
  const visible = useMemo(
    () => (query.trim() ? filterAccounts(accounts, { q: query }, 0) : accounts),
    [accounts, query],
  );
  const visibleSelected = useMemo(
    () => visible.filter((account) => selected.has(account.id)).length,
    [visible, selected],
  );
  const allVisible = visible.length > 0 && visibleSelected === visible.length;
  const someVisible = visibleSelected > 0 && !allVisible;

  const toggle = useCallback(
    (id: string) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

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
  const selectedCount = useMemo(
    () => accounts.reduce((count, account) => count + (selected.has(account.id) ? 1 : 0), 0),
    [accounts, selected],
  );

  /** Fetches the export of the selection; a server error is said in the dialog. */
  const fetchExport = async (task: ExportTask): Promise<ExportData | null> => {
    const ids = selectedIds();
    if (ids.length === 0) return null;
    try {
      return await exportAccounts(ids);
    } catch (error) {
      setFailure({ task, error });
      return null;
    }
  };

  const withBusy = async (kind: ExportTask, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setFailure(null);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };

  const onCopy = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    copied.clear();
    let fetchError: unknown = null;
    // The promise goes to copyText at once, so Safari keeps the click's user activation.
    const text = exportAccounts(ids).then(
      (data) => JSON.stringify(buildExportCopy(data), null, 2),
      (error: unknown) => {
        fetchError = error;
        throw error;
      },
    );
    void withBusy("copy", async () => {
      const ok = await copyText(text);
      if (ok) {
        copied.flash();
        announce(t("export.copied"));
      } else if (fetchError) setFailure({ task: "copy", error: fetchError });
      else setFailure({ task: "copy", error: null, message: tc("copy.failed") });
    });
  };

  const onDownload = () =>
    withBusy("download", async () => {
      const data = await fetchExport("download");
      if (data) saveJson(data, exportFilename());
    });

  // Try again runs the failed task once more; it and close leave focus on that task's control.
  const taskControl = (task: ExportTask) =>
    task === "copy" ? copyRef.current : downloadRef.current;
  const retry = (task: ExportTask) => {
    taskControl(task)?.focus();
    if (task === "copy") onCopy();
    else void onDownload();
  };

  const nothingSelected = selectedCount === 0;

  // Phones: one footer row, Cancel and then Copy and Download as icons named by their tooltips.
  const iconOnly = useMediaQuery("max-sm");
  /** A footer action; on phones its icon alone, its name in a tooltip. */
  const footerAction = (name: string, button: JSX.Element) =>
    iconOnly ? (
      <Tooltip>
        <TooltipTrigger aria-label={name} render={button} />
        <TooltipPopup>{name}</TooltipPopup>
      </Tooltip>
    ) : (
      button
    );

  return (
    <ResponsiveDialog
      description={t("export.pickDescription")}
      footer={
        // One child: the phone footer gives it the whole row; from sm up its buttons sit at the
        // footer's end as before.
        <div className="flex gap-2 sm:contents">
          <Button className="max-sm:flex-1" onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.cancel")}
          </Button>
          {footerAction(
            t("export.copyJson"),
            <Button
              disabled={nothingSelected || (busy !== null && busy !== "copy")}
              loading={busy === "copy"}
              onClick={onCopy}
              ref={copyRef}
              size={iconOnly ? "icon" : "default"}
              variant="secondary"
            >
              {copied.saved ? (
                <HugeiconsIcon
                  icon={CheckIcon}
                  aria-hidden="true"
                  className="text-success-foreground"
                />
              ) : (
                <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
              )}
              {iconOnly ? null : copied.saved ? tc("copy.copied") : t("export.copyJson")}
            </Button>,
          )}
          {footerAction(
            t("export.downloadJson"),
            <Button
              disabled={nothingSelected || (busy !== null && busy !== "download")}
              loading={busy === "download"}
              onClick={() => void onDownload()}
              ref={downloadRef}
              size={iconOnly ? "icon" : "default"}
            >
              <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
              {iconOnly ? null : t("export.downloadJson")}
            </Button>,
          )}
        </div>
      }
      onOpenChange={onOpenChange}
      open={open}
      panel={false}
      size="xl"
      title={t("export.title")}
    >
      {/*
        The body never scrolls as a whole, only its list, so the search and the picks above it
        stay in reach. On phones it asks for the
        whole screen and shrinks (min-h-0) to what the dialog leaves under its header and footer;
        it scrolls only on a screen too short for its controls.
      */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-1 pb-4 max-sm:h-dvh">
        <Alert role="note" variant="warning">
          <HugeiconsIcon icon={SquareLock02Icon} aria-hidden="true" />
          <AlertDescription>{t("export.description")}</AlertDescription>
        </Alert>
        {failure ? (
          <ActionError
            error={failure.error}
            message={failure.message}
            onDismiss={() => {
              taskControl(failure.task)?.focus();
              setFailure(null);
            }}
            onRetry={() => retry(failure.task)}
          />
        ) : null}
        {/*
        One height whatever the search leaves, so the dialog and its footer stay put: fixed from
        sm up (shrinking on a short window), the rest of the dialog on phones.
      */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 sm:h-[26rem] sm:flex-initial">
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
          {/*
              Quick picks: each sets the selection to one status group, as the Accounts tabs split
              it. The selection's count ends their row (the last line, when they wrap).
            */}
          <fieldset
            aria-label={t("export.quickSelect")}
            className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
          >
            {QUICK_GROUPS.map((group) => {
              const count = groupIds(group).length;
              return (
                <button
                  aria-pressed={pickedGroup === group}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 font-medium text-xs transition-colors focus-visible:focus-outline disabled:cursor-default disabled:opacity-50 aria-pressed:bg-foreground aria-pressed:text-background not-aria-pressed:text-muted-foreground not-aria-pressed:shadow-[inset_0_0_0_1px_var(--border)] not-aria-pressed:hover:bg-accent not-aria-pressed:hover:text-foreground pointer-coarse:h-8"
                  disabled={count === 0}
                  key={group}
                  onClick={() => {
                    setPick(group);
                    setSelected(new Set(groupIds(group)));
                  }}
                  type="button"
                >
                  {t(
                    group === "all"
                      ? "filter.all"
                      : group === "attention"
                        ? "filter.attention"
                        : `health.${group}`,
                  )}
                  <span className="tabular-nums opacity-70">{formatNumber(count, lang)}</span>
                </button>
              );
            })}
            <p
              aria-live="polite"
              className="ms-auto ps-1.5 text-meta text-muted-foreground tabular-nums"
            >
              {nothingSelected
                ? t("export.noSelection")
                : t("export.selected", { count: selectedCount })}
            </p>
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
              overscrollContain
              scrollFade
            >
              {/*
                  Positioned, so the rows' visually hidden text (absolute) stays inside this scroll
                  box: without it the hidden text of every row stretched the dialog thousands of
                  pixels under the list.
                */}
              <ul aria-label={t("export.list")} className="relative divide-y divide-border-subtle">
                {visible.map((account) => (
                  <ExportRow
                    account={account}
                    checked={selected.has(account.id)}
                    key={account.id}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            </ScrollArea>
          ) : (
            <p className="m-auto text-muted-foreground text-sm">{tc("state.noMatches")}</p>
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
});

import {
  CircleCheckIcon,
  CircleOffIcon,
  Delete02Icon,
  Download01Icon,
  Layers01Icon,
  Refresh01Icon,
  Tag01Icon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-media-query";
import { announce } from "@/lib/announce";
import { batchAccounts } from "@/lib/api/accounts";
import type {
  Account,
  AccountActionResult,
  BatchAccountsResponse,
  BatchAction,
  BatchDeleteResponse,
  BatchEnableDisableResponse,
  BatchRefreshModelsResponse,
  BatchRefreshResponse,
} from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import type { ReportAccountFailure } from "./account-failure";
import { describeFailures, isBanned } from "./account-model";
import { useInvalidateAccounts } from "./use-account-actions";

/**
 * Sticks to the bottom of the viewport (above the home indicator) while the list scrolls under
 * it, so the actions stay in reach after selecting a row far down the page. The page renders it
 * after the list, so it rests below the last row once the list ends.
 */
const BAR_POSITION =
  "sticky bottom-[calc(env(safe-area-inset-bottom,0px)+(--spacing(3)))] z-20 floating-shadow";

const CONFIRM_KEYS: Record<BatchAction, string> = {
  enable: "batch.confirmEnable",
  disable: "batch.confirmDisable",
  refresh: "batch.confirmRefresh",
  refreshModels: "batch.confirmRefreshModels",
  delete: "batch.confirmDelete",
};

/**
 * The actions that wait while a batch runs. The app's usual 64 % disabled fade still reads as a
 * live white label on the purple bar, so they fade further; the running one keeps full strength.
 */
const WAITING = "aria-disabled:not-aria-busy:opacity-40";

const ACTION_ICONS: Record<BatchAction, IconSvgElement> = {
  enable: CircleCheckIcon,
  disable: CircleOffIcon,
  refresh: Refresh01Icon,
  refreshModels: Layers01Icon,
  delete: Delete02Icon,
};

/** The names of failed accounts, as the list shows them (masked under privacy). */
export function useAccountNameOf(accounts: readonly Account[]): (id: string) => string {
  const displayEmail = useDisplayEmail();
  return (id) => {
    const account = accounts.find((item) => item.id === id);
    return account ? displayEmail(account.email, account.id) : id;
  };
}

/** The ids of a batch answer's failed rows that are still in the list, to select again. */
export function failedIdsIn(
  results: readonly AccountActionResult[] | undefined,
  accounts: readonly Account[],
): string[] {
  const failed = new Set((results ?? []).filter((row) => !row.ok).map((row) => row.id));
  return accounts.filter((account) => failed.has(account.id)).map((account) => account.id);
}

/**
 * The batch actions over the selection, run for the page (the bar unmounts with the selection).
 * Each confirms first; while it runs the bar's button spins (BatchBar).
 * Batch endpoints answer 200 even when items fail, so `failed` and the per-id `results` are read.
 * A clean run clears the selection and a screen reader hears the result; a partial
 * one keeps only the failed accounts selected and names them at the top of the accounts card,
 * where Try again runs the action on them; a failed request keeps the selection and says why.
 */
export function useBatchActions({
  accounts,
  selectedIds,
  select,
  report,
  target,
}: {
  /** The whole list, to name failed accounts. */
  accounts: Account[];
  selectedIds: string[];
  /** Sets the selection; empty clears it (and the bar goes). */
  select: (ids: string[]) => void;
  /** Says a failure in the accounts card. */
  report: ReportAccountFailure;
  /** The action's button on the bar (or what stands in for it), for focus after the notice. */
  target: (action: BatchAction) => HTMLElement | null | undefined;
}): { running: BatchAction | null; run: (action: BatchAction) => Promise<void> } {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const confirm = useConfirm();
  const invalidate = useInvalidateAccounts();
  const nameOf = useAccountNameOf(accounts);
  const [running, setRunning] = useState<BatchAction | null>(null);

  const execute = async (action: BatchAction, ids: string[]) => {
    report(null);
    setRunning(action);
    try {
      const result = await batchAccounts({ ids, action });
      const outcome = batchOutcome(action, result, nameOf, t);
      if (outcome.failed) {
        const again = failedIdsIn(result.results, accounts);
        select(again);
        report({
          error: null,
          message: outcome.details
            ? tc("text.joinSentences", { first: outcome.title, second: outcome.details })
            : outcome.title,
          retry: again.length > 0 ? () => void execute(action, again) : undefined,
          target: () => target(action),
          accountIds: again,
        });
      } else {
        announce(outcome.title);
        select([]);
      }
    } catch (error) {
      report({
        error,
        retry: () => {
          select(ids);
          void execute(action, ids);
        },
        target: () => target(action),
        accountIds: ids,
      });
    } finally {
      setRunning(null);
      await invalidate({ withStatus: true });
    }
  };

  const run = async (action: BatchAction) => {
    if (running || selectedIds.length === 0) return;
    // The row switch never turns a banned account on (signing in again lifts a ban), so Enable
    // leaves the banned ones out too, though the server would clear their ban.
    const banned = new Set(
      action === "enable"
        ? accounts
            .filter((account) => selectedIds.includes(account.id) && isBanned(account))
            .map((a) => a.id)
        : [],
    );
    const ids = selectedIds.filter((id) => !banned.has(id));
    if (ids.length === 0) {
      report({
        error: null,
        message: t("batch.enableAllBanned", { count: banned.size }),
        target: () => target(action),
        accountIds: [...banned],
      });
      return;
    }
    const ok = await confirm({
      title: t(CONFIRM_KEYS[action], { count: ids.length }),
      description:
        action === "delete"
          ? t("confirmDelete.body")
          : banned.size > 0
            ? t("batch.enableSkipsBanned", { count: banned.size })
            : undefined,
      confirmLabel: t(`batch.verb.${action}`),
      variant: action === "disable" || action === "delete" ? "danger" : "default",
    });
    if (!ok) return;
    await execute(action, ids);
  };

  return { running, run };
}

/**
 * Batch actions over the selection, on the purple inverted toolbar. The page runs them
 * (useBatchActions). While one runs the bar keeps its layout: that action's button spins, the
 * others fade, and the close button steps out of sight (it would do nothing) but keeps its place.
 */
export function BatchBar({
  selectedIds,
  running,
  onRun,
  onClear,
  onExport,
  onTags,
}: {
  selectedIds: string[];
  /** The action running now, if any. */
  running: BatchAction | null;
  /** Confirms and runs an action over the selection. */
  onRun: (action: BatchAction) => void;
  onClear: () => void;
  /** Opens the export dialog with the selection checked. */
  onExport: () => void;
  /** Opens the dialog that adds or removes a tag on the selection. */
  onTags: () => void;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const isMobile = useIsMobile();
  const count = selectedIds.length;
  const run = (action: BatchAction) => {
    if (!running && count > 0) onRun(action);
  };

  const busy = running !== null;
  const runningLabel =
    running === "delete"
      ? t("batch.deleting")
      : running === "refreshModels"
        ? t("detail.refreshingModels")
        : running
          ? t("batch.processing")
          : null;
  // The live count line. While a batch runs its action's button spins and the count stays (the
  // bar keeps its width); the run is named for screen readers only. A phone shows the bare
  // number, so every action fits on one row; a screen reader still hears "3 selected".
  const countLabel = (
    <p
      aria-live="polite"
      className={cn(
        "whitespace-nowrap px-1.5 text-sm tabular-nums",
        isMobile ? "min-w-0 flex-1 px-1 font-semibold" : "font-medium",
      )}
    >
      {isMobile ? (
        <>
          <span aria-hidden="true">{formatNumber(count, lang)}</span>
          <span className="sr-only">{t("batch.selected", { count })}</span>
        </>
      ) : (
        t("batch.selected", { count })
      )}
      {runningLabel ? <span className="sr-only">{runningLabel}</span> : null}
    </p>
  );

  /** One action as a toolbar button; `label` is the visible text, `name` the full name. */
  const actionButton = (action: BatchAction, label: string, name?: string) => (
    <ToolbarButton
      aria-label={name}
      className={WAITING}
      data-batch-action={action}
      disabled={busy && running !== action}
      key={action}
      onClick={() => run(action)}
      render={
        <Button
          loading={running === action}
          size="sm"
          variant={action === "delete" ? "on-primary-danger" : "on-primary"}
        />
      }
    >
      <HugeiconsIcon icon={ACTION_ICONS[action]} aria-hidden="true" />
      {label}
    </ToolbarButton>
  );

  /**
   * One action as an icon button, named by its tooltip (phones). A batch action spins while it
   * runs; Tags and Export open their dialogs.
   */
  const iconButton = (
    name: string,
    icon: IconSvgElement,
    onClick: () => void,
    action?: BatchAction,
  ) => (
    <Tooltip key={name}>
      <TooltipTrigger
        render={
          <ToolbarButton
            aria-label={name}
            className={WAITING}
            data-batch-action={action}
            disabled={busy && (action === undefined || running !== action)}
            onClick={onClick}
            render={
              <Button
                loading={action !== undefined && running === action}
                size="icon-sm"
                variant={action === "delete" ? "on-primary-danger" : "on-primary"}
              />
            }
          />
        }
      >
        <HugeiconsIcon icon={icon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{name}</TooltipPopup>
    </Tooltip>
  );
  const iconAction = (action: BatchAction, name: string) =>
    iconButton(name, ACTION_ICONS[action], () => run(action), action);

  const clearButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToolbarButton
            aria-label={t("batch.clear")}
            className={cn(busy && "invisible")}
            disabled={busy}
            // Out of the keyboard's way too while it is out of sight.
            focusableWhenDisabled={false}
            onClick={onClear}
            render={<Button size="icon-sm" variant="on-primary" />}
          />
        }
      >
        <HugeiconsIcon icon={XIcon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{t("batch.clear")}</TooltipPopup>
    </Tooltip>
  );

  return (
    <Toolbar
      aria-label={t("batch.label")}
      className={cn(
        BAR_POSITION,
        "flex-wrap",
        !isMobile && "max-w-full justify-center self-center",
      )}
      data-slot="batch-bar"
      variant="inverted"
    >
      {isMobile ? (
        // Phones: one row, the clear button and the count, then every action as an icon.
        <>
          <ToolbarGroup className="min-w-0 flex-1">
            {clearButton}
            {countLabel}
          </ToolbarGroup>
          <ToolbarGroup className="min-[375px]:gap-2">
            {iconAction("enable", t("batch.enable"))}
            {iconAction("disable", t("batch.disable"))}
            {iconAction("refresh", t("batch.refresh"))}
            {iconAction("refreshModels", t("batch.refreshModels"))}
            {iconButton(t("metadata.batchTags"), Tag01Icon, onTags)}
            {iconButton(t("batch.export"), Download01Icon, onExport)}
            {iconAction("delete", t("batch.delete"))}
          </ToolbarGroup>
        </>
      ) : (
        <>
          <ToolbarGroup>
            {countLabel}
            {clearButton}
          </ToolbarGroup>
          <ToolbarSeparator orientation="vertical" />
          <ToolbarGroup>
            {actionButton("enable", t("batch.enableShort"), t("batch.enable"))}
            {actionButton("disable", t("batch.disableShort"), t("batch.disable"))}
            {actionButton("refresh", t("batch.refresh"))}
            {actionButton("refreshModels", t("batch.refreshModels"))}
            <ToolbarButton
              className={WAITING}
              disabled={busy}
              onClick={onTags}
              render={<Button size="sm" variant="on-primary" />}
            >
              <HugeiconsIcon icon={Tag01Icon} aria-hidden="true" />
              {t("metadata.batchTags")}
            </ToolbarButton>
            <ToolbarButton
              aria-label={t("batch.export")}
              className={WAITING}
              disabled={busy}
              onClick={onExport}
              render={<Button size="sm" variant="on-primary" />}
            >
              <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
              {t("actions.export")}
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarSeparator orientation="vertical" />
          {actionButton("delete", t("batch.verb.delete"), t("batch.delete"))}
        </>
      )}
    </Toolbar>
  );
}

/** A batch answer in words: counts in the title, the failed accounts named in `details`. */
interface BatchOutcome {
  failed: boolean;
  title: string;
  details: string;
}

function batchOutcome(
  action: BatchAction,
  result: BatchAccountsResponse,
  nameOf: (id: string) => string,
  t: TFunction,
): BatchOutcome {
  const results: AccountActionResult[] | undefined = result.results;
  const failedCount = (result as { failed?: number }).failed ?? 0;
  const details = describeFailures(results, nameOf, t);
  const failed = failedCount > 0;
  if (action === "refresh") {
    const { refreshed = 0, suspended = 0 } = result as Partial<BatchRefreshResponse>;
    return {
      failed,
      title:
        suspended > 0
          ? t("batch.refreshSuspendedResult", { count: refreshed, suspended, failed: failedCount })
          : t("batch.refreshResult", { count: refreshed, failed: failedCount }),
      details,
    };
  }
  if (action === "refreshModels") {
    const { refreshed = 0 } = result as Partial<BatchRefreshModelsResponse>;
    return {
      failed,
      title: t("batch.refreshModelsResult", { count: refreshed, failed: failedCount }),
      details,
    };
  }
  if (action === "delete") {
    const { deleted = 0 } = result as Partial<BatchDeleteResponse>;
    return {
      failed,
      title: t("batch.deleteResult", { count: deleted, failed: failedCount }),
      details,
    };
  }
  // `count` counts the accounts saved; unknown ids are in `failed`.
  const { count = 0 } = result as Partial<BatchEnableDisableResponse>;
  return {
    failed,
    title: t(action === "enable" ? "batch.enableResult" : "batch.disableResult", { count }),
    details,
  };
}

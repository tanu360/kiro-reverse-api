import {
  CircleCheckIcon,
  CircleOffIcon,
  Delete02Icon,
  Download01Icon,
  EllipsisVerticalIcon,
  Layers01Icon,
  Refresh01Icon,
  Tag01Icon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
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
import { type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import type { ReportAccountFailure } from "./account-failure";
import { describeFailures } from "./account-model";
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
 * Each confirms first; while it runs the bar's button spins and its count line says what runs.
 * Batch endpoints answer 200 even when items fail, so `failed` and the per-id `results` are read.
 * No toasts: a clean run clears the selection and a screen reader hears the result; a partial
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
      });
    } finally {
      setRunning(null);
      await invalidate({ withStatus: true });
    }
  };

  const run = async (action: BatchAction) => {
    if (running || selectedIds.length === 0) return;
    const ids = [...selectedIds];
    const ok = await confirm({
      title: t(CONFIRM_KEYS[action], { count: ids.length }),
      description: action === "delete" ? t("confirmDelete.body") : undefined,
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
 * (useBatchActions); while one runs, its button spins and the count line says what runs.
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
  const { t } = useT("accounts");
  const isMobile = useIsMobile();
  const count = selectedIds.length;
  const run = (action: BatchAction) => {
    if (!running && count > 0) onRun(action);
  };

  const busy = running !== null;
  // The live count line says what runs while a batch runs, in place of a loading toast.
  const countLabel = (
    <p aria-live="polite" className="whitespace-nowrap px-1.5 font-medium text-sm tabular-nums">
      {running === "delete"
        ? t("batch.deleting")
        : running === "refreshModels"
          ? t("detail.refreshingModels")
          : running
            ? t("batch.processing")
            : t("batch.selected", { count })}
    </p>
  );

  /** One action as a toolbar button; `label` is the visible text, `name` the full name. */
  const actionButton = (action: BatchAction, label: string, name?: string, className?: string) => (
    <ToolbarButton
      aria-label={name}
      className={className}
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

  const clearButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToolbarButton
            aria-label={t("batch.clear")}
            disabled={busy}
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

  const menuLoading = running === "refresh" || running === "refreshModels" || running === "delete";

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
      {/* Phones: two rows, the count with its clear button over the actions. */}
      <ToolbarGroup className={cn(isMobile && "w-full justify-between")}>
        {countLabel}
        {clearButton}
      </ToolbarGroup>
      {isMobile ? (
        // The common actions stay on the bar, the rest sit in its menu.
        <ToolbarGroup className="w-full">
          {actionButton("enable", t("batch.enableShort"), t("batch.enable"), "flex-1")}
          {actionButton("disable", t("batch.disableShort"), t("batch.disable"), "flex-1")}
          <Menu>
            <ToolbarButton
              aria-label={t("batch.more")}
              data-batch-more=""
              disabled={busy && !menuLoading}
              render={
                <MenuTrigger
                  render={<Button loading={menuLoading} size="icon-sm" variant="on-primary" />}
                />
              }
            >
              <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
            </ToolbarButton>
            <MenuPopup align="end">
              <MenuItem onClick={() => run("refresh")}>
                <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
                {t("batch.refresh")}
              </MenuItem>
              <MenuItem onClick={() => run("refreshModels")}>
                <HugeiconsIcon icon={Layers01Icon} aria-hidden="true" />
                {t("batch.refreshModels")}
              </MenuItem>
              <MenuItem onClick={onTags}>
                <HugeiconsIcon icon={Tag01Icon} aria-hidden="true" />
                {t("metadata.batchTags")}
              </MenuItem>
              <MenuItem onClick={onExport}>
                <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                {t("batch.export")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => run("delete")} variant="destructive">
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("batch.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </ToolbarGroup>
      ) : (
        <>
          <ToolbarSeparator orientation="vertical" />
          <ToolbarGroup>
            {actionButton("enable", t("batch.enableShort"), t("batch.enable"))}
            {actionButton("disable", t("batch.disableShort"), t("batch.disable"))}
            {actionButton("refresh", t("batch.refresh"))}
            {actionButton("refreshModels", t("batch.refreshModels"))}
            <ToolbarButton
              disabled={busy}
              onClick={onTags}
              render={<Button size="sm" variant="on-primary" />}
            >
              <HugeiconsIcon icon={Tag01Icon} aria-hidden="true" />
              {t("metadata.batchTags")}
            </ToolbarButton>
            <ToolbarButton
              aria-label={t("batch.export")}
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

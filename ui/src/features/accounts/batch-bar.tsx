import {
  CircleCheckIcon,
  CircleOffIcon,
  Delete02Icon,
  Download01Icon,
  EllipsisVerticalIcon,
  Layers01Icon,
  Refresh01Icon,
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
import { batchAccounts } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
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
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { describeFailures } from "./account-model";
import { useInvalidateAccounts } from "./use-account-actions";

/**
 * Sticks to the bottom of the viewport (above the home indicator) while the list scrolls under
 * it, so the actions stay in reach after selecting a row far down the page. The page renders it
 * after the list, so it rests below the last row once the list ends.
 */
const BAR_POSITION =
  "sticky bottom-[calc(env(safe-area-inset-bottom,0px)+--spacing(3))] z-20 floating-shadow";

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

/**
 * Batch actions over the selection, on the purple inverted toolbar. Each confirms first, shows a
 * loading toast and replaces it with the result. Batch endpoints answer 200 even when items
 * fail, so `failed` and the per-id `results` are read; the failures are named in the toast.
 */
export function BatchBar({
  selectedIds,
  accounts,
  onClear,
  onExport,
}: {
  selectedIds: string[];
  /** The whole list, to name failed accounts in a result toast. */
  accounts: Account[];
  onClear: () => void;
  /** Opens the export dialog with the selection checked. */
  onExport: () => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const confirm = useConfirm();
  const isMobile = useIsMobile();
  const invalidate = useInvalidateAccounts();
  const displayEmail = useDisplayEmail();
  const [running, setRunning] = useState<BatchAction | null>(null);
  const count = selectedIds.length;

  const nameOf = (id: string) => {
    const account = accounts.find((item) => item.id === id);
    return account ? displayEmail(account.email, account.id) : id;
  };

  const run = async (action: BatchAction) => {
    if (running || count === 0) return;
    const ids = [...selectedIds];
    const ok = await confirm({
      title: t(CONFIRM_KEYS[action], { count: ids.length }),
      description: action === "delete" ? t("confirmDelete.body") : undefined,
      confirmLabel: t(`batch.verb.${action}`),
      variant: action === "disable" || action === "delete" ? "danger" : "default",
    });
    if (!ok) return;
    setRunning(action);
    const toastId = toast.loading(
      action === "delete"
        ? t("batch.deleting")
        : action === "refreshModels"
          ? t("detail.refreshingModels")
          : t("batch.processing"),
    );
    try {
      const result = await batchAccounts({ ids, action });
      toast.update(toastId, resultToast(action, result, nameOf, t));
      onClear();
    } catch (error) {
      toast.update(toastId, { type: "error", title: errorMessage(error, t) });
    } finally {
      setRunning(null);
      await invalidate({ withStatus: true });
    }
  };

  const busy = running !== null;
  const countLabel = (
    <p aria-live="polite" className="whitespace-nowrap px-1.5 font-medium text-sm tabular-nums">
      {t("batch.selected", { count })}
    </p>
  );

  /** One action as a toolbar button; `label` is the visible text, `name` the full name. */
  const actionButton = (action: BatchAction, label: string, name?: string, className?: string) => (
    <ToolbarButton
      aria-label={name}
      className={className}
      disabled={busy && running !== action}
      key={action}
      onClick={() => void run(action)}
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
              <MenuItem onClick={() => void run("refresh")}>
                <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
                {t("batch.refresh")}
              </MenuItem>
              <MenuItem onClick={() => void run("refreshModels")}>
                <HugeiconsIcon icon={Layers01Icon} aria-hidden="true" />
                {t("batch.refreshModels")}
              </MenuItem>
              <MenuItem onClick={onExport}>
                <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
                {t("batch.export")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void run("delete")} variant="destructive">
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

type ResultToast = { type: "success" | "warning"; title: string; description?: string };

/** The settled toast of a batch answer: counts in the title, failed accounts named below. */
function resultToast(
  action: BatchAction,
  result: BatchAccountsResponse,
  nameOf: (id: string) => string,
  t: TFunction,
): ResultToast {
  const results: AccountActionResult[] | undefined = result.results;
  const failedCount = (result as { failed?: number }).failed ?? 0;
  const description = describeFailures(results, nameOf, t) || undefined;
  const type = failedCount > 0 ? "warning" : "success";
  if (action === "refresh") {
    const { refreshed = 0, suspended = 0 } = result as Partial<BatchRefreshResponse>;
    return {
      type,
      title:
        suspended > 0
          ? t("batch.refreshSuspendedResult", { count: refreshed, suspended, failed: failedCount })
          : t("batch.refreshResult", { count: refreshed, failed: failedCount }),
      description,
    };
  }
  if (action === "refreshModels") {
    const { refreshed = 0 } = result as Partial<BatchRefreshModelsResponse>;
    return {
      type,
      title: t("batch.refreshModelsResult", { count: refreshed, failed: failedCount }),
      description,
    };
  }
  if (action === "delete") {
    const { deleted = 0 } = result as Partial<BatchDeleteResponse>;
    return {
      type,
      title: t("batch.deleteResult", { count: deleted, failed: failedCount }),
      description,
    };
  }
  // `count` counts the accounts saved; unknown ids are in `failed`.
  const { count = 0 } = result as Partial<BatchEnableDisableResponse>;
  return {
    type,
    title: t(action === "enable" ? "batch.enableResult" : "batch.disableResult", { count }),
    description,
  };
}

import {
  CircleCheckIcon,
  CircleOffIcon,
  Delete02Icon,
  EllipsisVerticalIcon,
  Layers01Icon,
  Refresh01Icon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useIsMobile } from "@/hooks/use-media-query";
import { batchAccounts, refreshAccountModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type {
  BatchAction,
  BatchDeleteResponse,
  BatchEnableDisableResponse,
  BatchRefreshResponse,
} from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useInvalidateAccounts } from "./use-account-actions";

type BarAction = BatchAction | "refreshModels";

/**
 * Sticks to the bottom of the viewport (above the home indicator) while the list scrolls under
 * it, so the actions stay in reach after selecting a card far down the page. The page renders
 * it after the list, so it rests below the last row once the list ends.
 */
const BAR_CLASS = cn(
  "sticky bottom-[calc(env(safe-area-inset-bottom,0px)+--spacing(3))] z-20 flex rounded-xl",
  // The purple main-button finish (grain and a white top highlight) on the whole bar, lifted
  // off the list; the focus outline turns white so it still shows on the purple.
  "grain-overlay [--grain-overlay-opacity:0.1] border border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/25 inset-shadow-[0_1px_--theme(--color-white/16%)] [--color-ring:var(--color-white)]",
);

/** A ghost button on the purple bar: white label and icon, a white wash on hover. */
const ON_BAR =
  "border-transparent text-primary-foreground [--control-icon-color:currentColor] *:data-[slot=button-loading-indicator]:text-primary-foreground [:hover,[data-pressed]]:bg-white/14";

/** The same on phones, where the buttons are filled so they read as buttons at a glance. */
const ON_BAR_FILLED = cn(ON_BAR, "bg-white/12");

/** A hairline between the bar's groups: the selection, the actions, delete. */
function BarDivider(): JSX.Element {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-white/24" />;
}

const CONFIRM_KEYS: Record<BarAction, string> = {
  enable: "batch.confirmEnable",
  disable: "batch.confirmDisable",
  refresh: "batch.confirmRefresh",
  refreshModels: "batch.confirmRefreshModels",
  delete: "batch.confirmDelete",
};

/**
 * Batch actions over the selection. Each confirms first, shows a loading toast and replaces it
 * with the result. Batch endpoints answer 200 even when items fail, so `failed` is read.
 */
export function BatchBar({
  selectedIds,
  onClear,
}: {
  selectedIds: string[];
  onClear: () => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const confirm = useConfirm();
  const isMobile = useIsMobile();
  const invalidate = useInvalidateAccounts();
  const [running, setRunning] = useState<BarAction | null>(null);
  const count = selectedIds.length;

  const run = async (action: BarAction) => {
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
      if (action === "refreshModels") {
        // One account at a time, like the old UI; failures are counted, not thrown.
        let succeeded = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            await refreshAccountModels(id);
            succeeded++;
          } catch {
            failed++;
          }
        }
        toast.update(toastId, {
          type: failed > 0 ? "warning" : "success",
          title: t("batch.refreshModelsResult", { count: succeeded, failed }),
        });
      } else {
        const result = await batchAccounts({ ids, action });
        toast.update(toastId, resultToast(action, result, ids.length, t));
      }
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
    <p aria-live="polite" className="px-1 font-medium text-sm">
      {t("batch.selected", { count })}
    </p>
  );

  if (isMobile) {
    // Two rows of 40 px controls: the common actions stay visible, the rest sit in a menu.
    const menuAction = running === "refresh" || running === "refreshModels" || running === "delete";
    return (
      <section aria-label={t("batch.label")} className={cn(BAR_CLASS, "flex-col gap-2 p-2")}>
        <div className="flex items-center justify-between gap-2">
          {countLabel}
          <Button className={cn("h-10", ON_BAR)} disabled={busy} onClick={onClear} variant="ghost">
            <HugeiconsIcon icon={XIcon} aria-hidden="true" />
            {t("batch.clear")}
          </Button>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Button
            className={cn("h-10", ON_BAR_FILLED)}
            disabled={busy}
            loading={running === "enable"}
            onClick={() => void run("enable")}
            variant="ghost"
          >
            <HugeiconsIcon icon={CircleCheckIcon} aria-hidden="true" />
            {t("batch.enableShort")}
          </Button>
          <Button
            className={cn("h-10", ON_BAR_FILLED)}
            disabled={busy}
            loading={running === "disable"}
            onClick={() => void run("disable")}
            variant="ghost"
          >
            <HugeiconsIcon icon={CircleOffIcon} aria-hidden="true" />
            {t("batch.disableShort")}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("batch.more")}
                  className={cn("size-10", ON_BAR_FILLED)}
                  disabled={busy}
                  loading={menuAction}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem className="min-h-10" onClick={() => void run("refresh")}>
                <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
                {t("batch.refresh")}
              </MenuItem>
              <MenuItem className="min-h-10" onClick={() => void run("refreshModels")}>
                <HugeiconsIcon icon={Layers01Icon} aria-hidden="true" />
                {t("batch.refreshModels")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                className="min-h-10"
                onClick={() => void run("delete")}
                variant="destructive"
              >
                <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                {t("batch.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </section>
    );
  }

  // One row centred over the list: the count with its clear button, the actions (their full
  // names stay the accessible names), and delete set apart with a rose icon and a red hover.
  return (
    <section
      aria-label={t("batch.label")}
      className={cn(
        BAR_CLASS,
        "max-w-full flex-wrap items-center justify-center gap-1 self-center p-1.5",
      )}
    >
      <div className="flex items-center gap-0.5 ps-1.5">
        {countLabel}
        <Button
          aria-label={t("batch.clear")}
          disabled={busy}
          onClick={onClear}
          className={cn(ON_BAR, "text-primary-foreground/72 hover:text-primary-foreground")}
          size="icon-sm"
          title={t("batch.clear")}
          variant="ghost"
        >
          <HugeiconsIcon icon={XIcon} aria-hidden="true" />
        </Button>
      </div>
      <BarDivider />
      <Button
        aria-label={t("batch.enable")}
        className={ON_BAR}
        disabled={busy}
        loading={running === "enable"}
        onClick={() => void run("enable")}
        size="sm"
        variant="ghost"
      >
        <HugeiconsIcon icon={CircleCheckIcon} aria-hidden="true" />
        {t("batch.enableShort")}
      </Button>
      <Button
        aria-label={t("batch.disable")}
        className={ON_BAR}
        disabled={busy}
        loading={running === "disable"}
        onClick={() => void run("disable")}
        size="sm"
        variant="ghost"
      >
        <HugeiconsIcon icon={CircleOffIcon} aria-hidden="true" />
        {t("batch.disableShort")}
      </Button>
      <Button
        className={ON_BAR}
        disabled={busy}
        loading={running === "refresh"}
        onClick={() => void run("refresh")}
        size="sm"
        variant="ghost"
      >
        <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
        {t("batch.refresh")}
      </Button>
      <Button
        className={ON_BAR}
        disabled={busy}
        loading={running === "refreshModels"}
        onClick={() => void run("refreshModels")}
        size="sm"
        variant="ghost"
      >
        <HugeiconsIcon icon={Layers01Icon} aria-hidden="true" />
        {t("batch.refreshModels")}
      </Button>
      <BarDivider />
      <Button
        aria-label={t("batch.delete")}
        className={cn(
          ON_BAR,
          // Hover, press and click turn it solid red with a white label and icon, in both themes.
          "[--control-icon-color:var(--color-rose-200)] [:hover,[data-pressed]]:bg-red-600 [:hover,[data-pressed]]:text-white [:hover,[data-pressed]]:[--control-icon-color:var(--color-white)] active:bg-red-600 active:text-white active:[--control-icon-color:var(--color-white)]",
        )}
        disabled={busy}
        loading={running === "delete"}
        onClick={() => void run("delete")}
        size="sm"
        variant="ghost"
      >
        <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
        {t("batch.verb.delete")}
      </Button>
    </section>
  );
}

function resultToast(
  action: BatchAction,
  result: unknown,
  requested: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): { type: "success" | "warning"; title: string } {
  if (action === "refresh") {
    const { refreshed = 0, failed = 0 } = result as Partial<BatchRefreshResponse>;
    return {
      type: failed > 0 ? "warning" : "success",
      title: t("batch.refreshResult", { count: refreshed, failed }),
    };
  }
  if (action === "delete") {
    const { deleted = 0, failed = 0 } = result as Partial<BatchDeleteResponse>;
    return {
      type: failed > 0 ? "warning" : "success",
      title: t("batch.deleteResult", { count: deleted, failed }),
    };
  }
  // `count` echoes the requested ids; fall back to them like the old UI.
  const count = (result as Partial<BatchEnableDisableResponse>).count || requested;
  return {
    type: "success",
    title: t(action === "enable" ? "batch.enableResult" : "batch.disableResult", { count }),
  };
}

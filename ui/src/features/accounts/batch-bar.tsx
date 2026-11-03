import {
  CircleCheckIcon,
  CircleOffIcon,
  LayersIcon,
  RotateCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type JSX, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
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
import { useInvalidateAccounts } from "./use-account-actions";

type BarAction = BatchAction | "refreshModels";

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
  const invalidate = useInvalidateAccounts();
  const [running, setRunning] = useState<BarAction | null>(null);
  const count = selectedIds.length;

  const run = async (action: BarAction) => {
    if (running || count === 0) return;
    const ids = [...selectedIds];
    const ok = await confirm({
      title: action === "delete" ? t("batch.deleteTitle") : t("batch.confirmTitle"),
      description: t(CONFIRM_KEYS[action], { count: ids.length }),
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
  return (
    <section
      aria-label={t("batch.label")}
      className="flex flex-col gap-2 rounded-xl border bg-muted/50 p-2 sm:flex-row sm:flex-wrap sm:items-center"
    >
      <p aria-live="polite" className="px-1 font-medium text-sm tabular-nums">
        {t("batch.selected", { count })}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 sm:ms-auto">
        <Button
          disabled={busy}
          loading={running === "enable"}
          onClick={() => void run("enable")}
          size="sm"
        >
          <CircleCheckIcon aria-hidden="true" />
          {t("batch.enable")}
        </Button>
        <Button
          disabled={busy}
          loading={running === "disable"}
          onClick={() => void run("disable")}
          size="sm"
          variant="outline"
        >
          <CircleOffIcon aria-hidden="true" />
          {t("batch.disable")}
        </Button>
        <Button
          disabled={busy}
          loading={running === "refresh"}
          onClick={() => void run("refresh")}
          size="sm"
          variant="outline"
        >
          <RotateCwIcon aria-hidden="true" />
          {t("batch.refresh")}
        </Button>
        <Button
          disabled={busy}
          loading={running === "refreshModels"}
          onClick={() => void run("refreshModels")}
          size="sm"
          variant="outline"
        >
          <LayersIcon aria-hidden="true" />
          {t("batch.refreshModels")}
        </Button>
        <Button
          disabled={busy}
          loading={running === "delete"}
          onClick={() => void run("delete")}
          size="sm"
          variant="destructive-outline"
        >
          <Trash2Icon aria-hidden="true" />
          {t("batch.delete")}
        </Button>
        <Button disabled={busy} onClick={onClear} size="sm" variant="ghost">
          <XIcon aria-hidden="true" />
          {t("batch.clear")}
        </Button>
      </div>
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

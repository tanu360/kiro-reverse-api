import { useMutation } from "@tanstack/react-query";
import { ListRestartIcon, ScanSearchIcon } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getAccountModels, refreshAccountModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { modelRate, sortModels } from "../account-model";
import { DetailSection } from "./detail-section";

/** Live model list (GET /models updates the server cache) and a route-cache refresh. */
export function ModelsSection({ accountId }: { accountId: string }): JSX.Element {
  const { t } = useT("accounts");

  const load = useMutation({
    mutationFn: () => getAccountModels(accountId),
    onError: (error) => {
      toast.error(t("detail.loadFailed", { reason: errorMessage(error, t) }));
    },
  });

  const refresh = useMutation({
    mutationFn: () => refreshAccountModels(accountId),
    onMutate: () => ({ toastId: toast.loading(t("detail.refreshingModels")) }),
    onSuccess: (result, _vars, context) => {
      toast.update(context.toastId, {
        type: "success",
        title: t("detail.modelsRefreshed", { count: result.count ?? 0 }),
      });
    },
    onError: (error, _vars, context) => {
      if (!context) return;
      toast.update(context.toastId, { type: "error", title: errorMessage(error, t) });
    },
  });

  const models = load.data ? sortModels(load.data.models) : null;
  return (
    <DetailSection
      actions={
        <>
          <Button
            loading={load.isPending}
            onClick={() => load.mutate()}
            size="sm"
            variant="outline"
          >
            <ScanSearchIcon aria-hidden="true" />
            {t("detail.loadModels")}
          </Button>
          <Button
            loading={refresh.isPending}
            onClick={() => refresh.mutate()}
            size="sm"
            variant="outline"
          >
            <ListRestartIcon aria-hidden="true" />
            {t("detail.refreshModelCache")}
          </Button>
        </>
      }
      title={t("detail.models")}
    >
      <div aria-live="polite">
        {load.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner aria-hidden="true" className="size-4" />
            {t("detail.modelsLoading")}
          </p>
        ) : load.isError ? (
          <p className="text-destructive-foreground text-sm" role="alert">
            {t("detail.loadFailed", { reason: errorMessage(load.error, t) })}
          </p>
        ) : models && models.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("detail.noModels")}</p>
        ) : models ? (
          <ul aria-label={t("detail.models")} className="flex flex-col divide-y rounded-lg border">
            {models.map((model) => (
              <li className="flex flex-col gap-0.5 px-3 py-2" key={model.modelId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="break-all font-mono text-sm">{model.modelId}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {t("detail.creditMultiplier", { ratio: modelRate(model) })}
                  </span>
                </div>
                {model.description ? (
                  <span className="text-muted-foreground text-xs">{model.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t("detail.modelsHint")}</p>
        )}
      </div>
    </DetailSection>
  );
}

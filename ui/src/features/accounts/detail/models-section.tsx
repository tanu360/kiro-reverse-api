import { BoxesIcon, ListRestartIcon, ScanSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import type { JSX } from "react";
import { ListCard } from "@/components/shared/list-card";
import { ModelLogo } from "@/components/shared/model-logo";
import { SectionCard } from "@/components/shared/section-card";
import { SettingsEmptyRow } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { getAccountModels, refreshAccountModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { modelRate, sortModels } from "../account-model";

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
    <SectionCard
      actions={
        // Both actions in the header: the route-cache refresh as an icon beside Load models.
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("detail.refreshModelCache")}
                  loading={refresh.isPending}
                  onClick={() => refresh.mutate()}
                  size="icon-sm"
                  variant="secondary"
                />
              }
            >
              <HugeiconsIcon icon={ListRestartIcon} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{t("detail.refreshModelCache")}</TooltipPopup>
          </Tooltip>
          <Button
            loading={load.isPending}
            onClick={() => load.mutate()}
            size="sm"
            variant="secondary"
          >
            <HugeiconsIcon icon={ScanSearchIcon} aria-hidden="true" />
            {t("detail.loadModels")}
          </Button>
        </div>
      }
      icon={BoxesIcon}
      slim
      title={t("detail.models")}
    >
      {/* Always holds one row (the hint, a state or the list), so the card keeps its hairline. */}
      <div aria-live="polite" className="min-w-0">
        {load.isPending ? (
          <SettingsEmptyRow className="flex items-center gap-2">
            <Spinner aria-hidden="true" className="size-3.5" />
            {t("detail.modelsLoading")}
          </SettingsEmptyRow>
        ) : load.isError ? (
          <SettingsEmptyRow>
            <span className="text-destructive-foreground" role="alert">
              {t("detail.loadFailed", { reason: errorMessage(load.error, t) })}
            </span>
          </SettingsEmptyRow>
        ) : models && models.length === 0 ? (
          <SettingsEmptyRow>{t("detail.noModels")}</SettingsEmptyRow>
        ) : models ? (
          <ul aria-label={t("detail.models")} className="divide-y divide-border-subtle">
            {models.map((model) => (
              <ListCard
                badge={
                  <Badge size="sm" tone="neutral">
                    {t("detail.creditMultiplier", { ratio: modelRate(model) })}
                  </Badge>
                }
                key={model.modelId}
                leading={<ModelLogo className="size-4" model={model.modelId} />}
                meta={model.description || undefined}
                render={<li />}
                title={<span className="font-mono text-meta">{model.modelId}</span>}
                variant="row"
              />
            ))}
          </ul>
        ) : (
          <SettingsEmptyRow>{t("detail.modelsHint")}</SettingsEmptyRow>
        )}
      </div>
    </SectionCard>
  );
}

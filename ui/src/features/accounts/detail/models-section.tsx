import { BoxesIcon, CheckIcon, ListRestartIcon, ScanSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useRef } from "react";
import { ActionError } from "@/components/shared/action-error";
import { ListCard } from "@/components/shared/list-card";
import { ModelLogo } from "@/components/shared/model-logo";
import { SectionCard } from "@/components/shared/section-card";
import { SettingsEmptyRow } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { getAccountModels, refreshAccountModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import { numberFormat } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { modelRate, sortModels } from "../account-model";

/**
 * Live model list (GET /models updates the server cache) and a route-cache refresh. The list
 * says how its load went; the refresh button spins, then shows a tick for two seconds
 * (a screen reader hears the model count), and a failed refresh is said at the top of the card.
 */
export function ModelsSection({ accountId }: { accountId: string }): JSX.Element {
  const { t, lang } = useT("accounts");
  const refreshRef = useRef<HTMLButtonElement | null>(null);
  const refreshed = useSavedFlash();

  const load = useMutation({
    mutationFn: () => getAccountModels(accountId),
  });

  const refresh = useMutation({
    mutationFn: () => refreshAccountModels(accountId),
    onMutate: () => refreshed.clear(),
    onSuccess: (result) => {
      refreshed.flash();
      announce(t("detail.modelsRefreshed", { count: result.count ?? 0 }));
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
                  ref={refreshRef}
                  size="icon-sm"
                  variant="secondary"
                />
              }
            >
              {refreshed.saved ? (
                <HugeiconsIcon
                  icon={CheckIcon}
                  aria-hidden="true"
                  className="text-success-foreground"
                />
              ) : (
                <HugeiconsIcon icon={ListRestartIcon} aria-hidden="true" />
              )}
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
      {refresh.isError ? (
        <CardPanel>
          <ActionError
            error={refresh.error}
            onDismiss={() => {
              refreshRef.current?.focus();
              refresh.reset();
            }}
            onRetry={() => {
              refreshRef.current?.focus();
              refresh.mutate();
            }}
          />
        </CardPanel>
      ) : null}
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
                    {t("detail.creditMultiplier", {
                      ratio: numberFormat(lang).format(modelRate(model)),
                    })}
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

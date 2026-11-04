import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JSX } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import { resetStats } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections";
import { ROW_DESCRIPTION, SettingsFrame, SettingsRow } from "./settings-section";

export function DangerZoneCard(): JSX.Element {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: resetStats,
    onSuccess: () => {
      toast.success(t("statsReset"));
      // Every view built on request history: the stat cards, Overview and Requests.
      for (const queryKey of [queryKeys.status, queryKeys.observe.all, queryKeys.requests.all]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => {
      toast.error(t("resetFailed", { reason: errorMessage(error, t) }));
    },
  });

  const onReset = async () => {
    const confirmed = await confirm({
      title: t("confirmResetTitle"),
      description: t("confirmResetBody"),
      confirmLabel: t("confirmResetAction"),
      variant: "danger",
    });
    if (confirmed) reset.mutate();
  };

  return (
    <SettingsFrame
      className="border-destructive/32"
      id={SECTION_ID.dangerZone}
      title={t("dangerZone")}
    >
      <SettingsRow className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-medium text-foreground text-sm">{t("statistics")}</h3>
          <p className={ROW_DESCRIPTION}>{t("resetStatsHint")}</p>
        </div>
        <Button
          className="self-start sm:self-center"
          disabled={reset.isPending}
          onClick={() => void onReset()}
          variant="destructive"
        >
          {t("resetStats")}
        </Button>
      </SettingsRow>
    </SettingsFrame>
  );
}

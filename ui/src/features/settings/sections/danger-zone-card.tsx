import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JSX } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import { resetStats } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SECTION_ID } from "./sections";
import { RowAction, SettingsGroup } from "./settings-section";

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

  // The danger tone comes from the section (sections.ts): a red-tinted card and a red row title.
  return (
    <SettingsGroup id={SECTION_ID.dangerZone} title={t("dangerZone")}>
      <SettingsRow
        control={
          // Under the description on a phone, so the description keeps the row's width.
          <RowAction>
            {/* Its own name: the row would otherwise name it after the row title ("Statistics"). */}
            <Button
              aria-label={t("resetStats")}
              loading={reset.isPending}
              onClick={() => void onReset()}
              size="sm"
              variant="danger"
            >
              <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
              {t("resetStats")}
            </Button>
          </RowAction>
        }
        controlWidth="actions"
        description={t("resetStatsHint")}
        title={t("statistics")}
        tone="danger"
      />
    </SettingsGroup>
  );
}

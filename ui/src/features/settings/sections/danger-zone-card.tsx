import { CheckIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type JSX, useRef } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { SettingsRow } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { queryKeys } from "@/lib/api/query-keys";
import { resetStats } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { SECTION_ID } from "./sections";
import { RowAction, RowActionError, SettingsGroup } from "./settings-section";

export function DangerZoneCard(): JSX.Element {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const resetRef = useRef<HTMLButtonElement>(null);
  const done = useSavedFlash();
  // The button spins, then reads "Done" for a moment; a failure shows under the row.
  const reset = useMutation({
    mutationFn: resetStats,
    onMutate: () => done.clear(),
    onSuccess: () => {
      done.flash();
      announce(t("statsReset"));
      // Every view built on request history: the stat cards, Overview and Requests.
      for (const queryKey of [queryKeys.status, queryKeys.observe.all, queryKeys.requests.all]) {
        void queryClient.invalidateQueries({ queryKey });
      }
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

  // A plain card like the others: only the button is red (the nav still marks the section red).
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
              ref={resetRef}
              size="sm"
              // Solid red with a white label in both themes: this one cannot be undone.
              variant="destructive"
            >
              <HugeiconsIcon icon={done.saved ? CheckIcon : Delete02Icon} aria-hidden="true" />
              {done.saved ? t("resetDone") : t("resetStats")}
            </Button>
          </RowAction>
        }
        controlWidth="actions"
        description={t("resetStatsHint")}
        title={t("statistics")}
      >
        {/* Try again resets at once: the reset was already confirmed. */}
        {reset.isError ? (
          <RowActionError
            error={reset.error}
            focusTarget={resetRef}
            onDismiss={reset.reset}
            onRetry={() => reset.mutate()}
          />
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}

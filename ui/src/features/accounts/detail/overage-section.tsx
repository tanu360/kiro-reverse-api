import { CloudDownloadIcon, ZapIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { PropertyList, PropertyRow } from "@/components/shared/property-list";
import { SectionCard } from "@/components/shared/section-card";
import { SwitchField } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { getAccountOverage, setAccountOverage } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, OverageResponse } from "@/lib/api/types";
import { formatDateTime, formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { overageCapable, overageEnabled } from "../account-model";

/** Merges an overage snapshot (not a full Account) into the cached list row. */
function useMergeOverage(accountId: string): (snapshot: OverageResponse) => void {
  const queryClient = useQueryClient();
  return (snapshot) => {
    queryClient.setQueryData<Account[]>(queryKeys.accounts.list(), (list) =>
      list?.map((account) =>
        account.id === accountId
          ? {
              ...account,
              overageStatus: snapshot.overageStatus,
              overageCapability: snapshot.overageCapability,
              overageCap: snapshot.overageCap,
              overageRate: snapshot.overageRate,
              currentOverages: snapshot.currentOverages,
              overageCheckedAt: snapshot.overageCheckedAt,
            }
          : account,
      ),
    );
  };
}

/** Both calls reach real AWS. No confirm for the toggle (old UI parity). */
export function OverageSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const merge = useMergeOverage(account.id);
  // The switch shows the requested state while the call runs, then the cached snapshot again.
  const [pending, setPending] = useState<boolean | null>(null);

  const failureToast = (toastId: string, error: unknown) =>
    toast.update(toastId, {
      type: "error",
      title: errorMessage(error, t, "accounts:detail.overageSwitchFailed"),
    });

  const sync = useMutation({
    mutationFn: () => getAccountOverage(account.id),
    onMutate: () => ({ toastId: toast.loading(t("detail.overageSwitching")) }),
    onSuccess: (snapshot, _vars, context) => {
      merge(snapshot);
      toast.update(context.toastId, { type: "success", title: t("detail.saved") });
    },
    onError: (error, _vars, context) => {
      if (context) failureToast(context.toastId, error);
    },
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setAccountOverage(account.id, enabled),
    onMutate: (enabled) => {
      setPending(enabled);
      return { toastId: toast.loading(t("detail.overageSwitching")) };
    },
    onSuccess: (snapshot, _vars, context) => {
      merge(snapshot);
      toast.update(context.toastId, { type: "success", title: t("detail.saved") });
    },
    onError: (error, _vars, context) => {
      if (context) failureToast(context.toastId, error);
    },
    onSettled: () => setPending(null),
  });

  const capable = overageCapable(account);
  const status = (account.overageStatus ?? "").toUpperCase();
  const statusLabel =
    status === "ENABLED"
      ? t("detail.overageEnabled")
      : status === "DISABLED"
        ? t("detail.overageDisabled")
        : t("detail.overageUnknown");

  return (
    <SectionCard
      actions={
        <Button
          loading={sync.isPending}
          onClick={() => sync.mutate()}
          size="sm"
          variant="secondary"
        >
          <HugeiconsIcon icon={CloudDownloadIcon} aria-hidden="true" />
          {t("detail.overageRefresh")}
        </Button>
      }
      icon={ZapIcon}
      slim
      title={t("detail.overage")}
    >
      <SwitchField
        checked={pending ?? overageEnabled(account)}
        description={t("detail.overageHint")}
        disabled={!capable || toggle.isPending}
        onCheckedChange={(checked) => toggle.mutate(checked)}
        title={t("detail.overageSwitch")}
      />
      <PropertyList>
        <PropertyRow label={t("detail.overageStatus")} value={statusLabel} />
        <PropertyRow label={t("detail.overageCap")} value={formatUsd(account.overageCap)} />
        <PropertyRow label={t("detail.overageRate")} value={formatUsd(account.overageRate)} />
        <PropertyRow
          label={t("detail.overageCurrent")}
          value={formatUsd(account.currentOverages)}
        />
        <PropertyRow
          label={t("detail.overageCheckedAt")}
          value={account.overageCheckedAt ? formatDateTime(account.overageCheckedAt, lang) : ""}
        />
        {capable ? null : (
          <PropertyRow
            label={t("detail.overageCapability")}
            value={t("detail.overageNotCapable")}
          />
        )}
      </PropertyList>
    </SectionCard>
  );
}

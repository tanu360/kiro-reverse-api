import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudDownloadIcon } from "lucide-react";
import { type JSX, useId, useState } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getAccountOverage, setAccountOverage } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, OverageResponse } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { overageCapable, overageEnabled } from "../account-model";
import { DetailSection } from "./detail-section";

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
  const switchId = useId();
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
    <DetailSection
      actions={
        <Button loading={sync.isPending} onClick={() => sync.mutate()} size="sm" variant="outline">
          <CloudDownloadIcon aria-hidden="true" />
          {t("detail.overageRefresh")}
        </Button>
      }
      title={t("detail.overage")}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is the control. */}
      <label className="flex items-start gap-3">
        <Switch
          aria-describedby={`${switchId}-hint`}
          aria-labelledby={`${switchId}-label`}
          checked={pending ?? overageEnabled(account)}
          disabled={!capable || toggle.isPending}
          onCheckedChange={(checked) => toggle.mutate(checked)}
        />
        <span className="flex flex-col gap-1">
          <span className="font-medium text-sm" id={`${switchId}-label`}>
            {t("detail.overageSwitch")}
          </span>
          <span className="text-muted-foreground text-xs" id={`${switchId}-hint`}>
            {t("detail.overageHint")}
          </span>
        </span>
      </label>
      <KeyValueGrid
        columns={3}
        items={[
          { label: t("detail.overageStatus"), value: statusLabel },
          { label: t("detail.overageCap"), value: formatUsd(account.overageCap) },
          { label: t("detail.overageRate"), value: formatUsd(account.overageRate) },
          { label: t("detail.overageCurrent"), value: formatUsd(account.currentOverages) },
          {
            label: t("detail.overageCheckedAt"),
            value: account.overageCheckedAt
              ? formatDateTime(account.overageCheckedAt, lang)
              : EMPTY,
          },
          ...(capable
            ? []
            : [{ label: t("detail.overageCapability"), value: t("detail.overageNotCapable") }]),
        ]}
      />
    </DetailSection>
  );
}

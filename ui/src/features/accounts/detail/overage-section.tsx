import { CloudDownloadIcon, ZapIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type JSX, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { SwitchField } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { announce } from "@/lib/announce";
import { getAccountOverage, setAccountOverage } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, OverageResponse } from "@/lib/api/types";
import { formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";
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

/**
 * Both calls reach real AWS. No confirm for the toggle (old UI parity). No toasts: while a call
 * runs its button spins, or the switch's title says "Calling AWS…"; the facts and the switch show
 * the result (a screen reader hears it), and a failure is said in the card, with Try again.
 */
export function OverageSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const merge = useMergeOverage(account.id);
  const syncRef = useRef<HTMLButtonElement | null>(null);
  const switchRef = useRef<HTMLElement | null>(null);
  // The switch shows the requested state while the call runs, then the cached snapshot again.
  const [pending, setPending] = useState<boolean | null>(null);
  // The last call that failed, with its control (focused as the notice goes) and its retry.
  const [failure, setFailure] = useState<{
    error: unknown;
    retry: () => void;
    target: () => HTMLElement | null;
  } | null>(null);

  const sync = useMutation({
    mutationFn: () => getAccountOverage(account.id),
    onMutate: () => setFailure(null),
    onSuccess: (snapshot) => {
      merge(snapshot);
      announce(t("detail.saved"));
    },
    onError: (error) =>
      setFailure({ error, retry: () => sync.mutate(), target: () => syncRef.current }),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setAccountOverage(account.id, enabled),
    onMutate: (enabled) => {
      setFailure(null);
      setPending(enabled);
    },
    onSuccess: (snapshot) => {
      merge(snapshot);
      announce(t("detail.saved"));
    },
    onError: (error, enabled) =>
      setFailure({
        error,
        retry: () => toggle.mutate(enabled),
        target: () => switchRef.current,
      }),
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

  const facts: KeyValueItem[] = [
    { label: t("detail.overageStatus"), value: statusLabel },
    { label: t("detail.overageCap"), value: formatUsd(account.overageCap) },
    { label: t("detail.overageRate"), value: formatUsd(account.overageRate) },
    { label: t("detail.overageCurrent"), value: formatUsd(account.currentOverages) },
    {
      label: t("detail.overageCheckedAt"),
      value: <RelativeTime value={account.overageCheckedAt} />,
    },
  ];
  if (!capable) {
    facts.push({ label: t("detail.overageCapability"), value: t("detail.overageNotCapable") });
  }

  return (
    <SectionCard
      actions={
        <Button
          loading={sync.isPending}
          onClick={() => sync.mutate()}
          ref={syncRef}
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
      {failure ? (
        <CardPanel>
          <ActionError
            error={failure.error}
            message={errorMessage(failure.error, t, "accounts:detail.overageSwitchFailed")}
            onDismiss={() => {
              failure.target()?.focus();
              setFailure(null);
            }}
            onRetry={() => {
              failure.target()?.focus();
              failure.retry();
            }}
          />
        </CardPanel>
      ) : null}
      <SwitchField
        checked={pending ?? overageEnabled(account)}
        description={t("detail.overageHint")}
        disabled={!capable || toggle.isPending}
        onCheckedChange={(checked) => toggle.mutate(checked)}
        status={
          toggle.isPending ? (
            <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
              <Spinner aria-hidden="true" className="size-3.5" />
              {t("detail.overageSwitching")}
            </span>
          ) : undefined
        }
        switchRef={switchRef}
        title={t("detail.overageSwitch")}
      />
      {/* Label over value, two across: the four numbers and the sync time in three short rows. */}
      <div className="p-4">
        <KeyValueGrid items={facts} />
      </div>
    </SectionCard>
  );
}

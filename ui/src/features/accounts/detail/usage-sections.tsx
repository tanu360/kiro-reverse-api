import type { JSX } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatCompact, formatDateTime, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { subscriptionLabel } from "../account-model";
import { DetailSection } from "./detail-section";

function credits(current: number, limit: number): string {
  return `${Number(current).toFixed(1)} / ${Number(limit).toFixed(0)}`;
}

export function SubscriptionSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const plan =
    account.subscriptionTitle ||
    (account.subscriptionType ? subscriptionLabel(account.subscriptionType, t) : "") ||
    EMPTY;
  const items = [
    { label: t("detail.plan"), value: plan },
    {
      label: t("detail.tokenExpiry"),
      value: account.expiresAt ? formatDateTime(account.expiresAt, lang) : EMPTY,
    },
    { label: t("detail.planCredits"), value: credits(account.usageCurrent, account.usageLimit) },
    { label: t("detail.resetDate"), value: account.nextResetDate || EMPTY },
  ];
  if (account.trialUsageLimit > 0) {
    items.push(
      {
        label: t("detail.trialCredits"),
        value: credits(account.trialUsageCurrent, account.trialUsageLimit),
      },
      { label: t("detail.trialStatus"), value: account.trialStatus || EMPTY },
      {
        label: t("detail.trialExpiry"),
        value: account.trialExpiresAt ? formatDateTime(account.trialExpiresAt, lang) : EMPTY,
      },
    );
  }
  return (
    <DetailSection title={t("detail.subscription")}>
      <KeyValueGrid items={items} />
    </DetailSection>
  );
}

export function StatisticsSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  return (
    <DetailSection title={t("detail.statistics")}>
      <KeyValueGrid
        items={[
          { label: t("detail.requests"), value: formatNumber(account.requestCount, lang) },
          { label: t("detail.errors"), value: formatNumber(account.errorCount, lang) },
          { label: t("detail.totalTokens"), value: formatCompact(account.totalTokens) },
          { label: t("detail.totalCredits"), value: Number(account.totalCredits).toFixed(2) },
        ]}
      />
    </DetailSection>
  );
}

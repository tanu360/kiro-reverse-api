import type { JSX } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatCompact, formatDateTime, formatNumber } from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { formatCreditAmount, formatResetDate, planLabel } from "../account-model";
import { DetailSection } from "./detail-section";

function credits(current: number, limit: number, lang: Lang): string {
  return `${formatCreditAmount(current, lang)} / ${formatCreditAmount(limit, lang)}`;
}

export function SubscriptionSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const items = [
    { label: t("detail.plan"), value: planLabel(account, t) },
    {
      label: t("detail.tokenExpiry"),
      value: account.expiresAt ? formatDateTime(account.expiresAt, lang) : EMPTY,
    },
    {
      label: t("detail.planCredits"),
      value: credits(account.usageCurrent, account.usageLimit, lang),
    },
    { label: t("detail.resetDate"), value: formatResetDate(account.nextResetDate, lang) },
  ];
  if (account.trialUsageLimit > 0) {
    items.push(
      {
        label: t("detail.trialCredits"),
        value: credits(account.trialUsageCurrent, account.trialUsageLimit, lang),
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
          {
            label: t("detail.totalCredits"),
            value: formatCreditAmount(account.totalCredits, lang),
          },
        ]}
      />
    </DetailSection>
  );
}

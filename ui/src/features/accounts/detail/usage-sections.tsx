import { CreditCardIcon } from "@hugeicons/core-free-icons";
import { type JSX, useId } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import { PropertyList, PropertyRow } from "@/components/shared/property-list";
import { SectionCard } from "@/components/shared/section-card";
import { StatStrip, type StatStripItem } from "@/components/shared/stat-strip";
import { Card } from "@/components/ui/card";
import type { Account } from "@/lib/api/types";
import { formatCompact, formatDateTime, formatNumber } from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { UsageMeter } from "../account-cells";
import { formatCreditAmount, formatResetDate, planLabel } from "../account-model";

function credits(current: number, limit: number, lang: Lang): string {
  return `${formatCreditAmount(current, lang)} / ${formatCreditAmount(limit, lang)}`;
}

/**
 * The sheet's opening card: the credits meter (plan, or trial for a trial-only account) over the
 * four lifetime numbers. Four across from a 28rem card, two by two below it (a phone sheet). The
 * section keeps the "Statistics" name for screen readers; the numbers carry their own labels.
 */
export function StatisticsSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const headingId = useId();
  const hasUsage = account.usageLimit > 0 || account.trialUsageLimit > 0;
  const stats: StatStripItem[] = [
    { label: t("detail.requests"), value: formatNumber(account.requestCount, lang) },
    { label: t("detail.errors"), value: formatNumber(account.errorCount, lang) },
    { label: t("detail.totalTokens"), value: formatCompact(account.totalTokens) },
    {
      label: t("detail.totalCredits"),
      value: (
        <CreditAmount
          digits={1}
          format={(value) => formatCreditAmount(value, lang)}
          value={account.totalCredits}
        />
      ),
    },
  ];
  return (
    <Card
      aria-labelledby={headingId}
      className="@container min-w-0"
      data-slot="section-card"
      render={<section />}
    >
      <h2 className="sr-only" id={headingId}>
        {t("detail.statistics")}
      </h2>
      {hasUsage ? (
        <div className="px-4 py-4 sm:px-6">
          <UsageMeter account={account} labelled />
        </div>
      ) : null}
      <StatStrip className={cn(hasUsage && "border-border-subtle border-t")} items={stats} />
    </Card>
  );
}

/**
 * The plan and its dates. Plan credits sit in the meter above; a trial's credits, state and
 * expiry follow when the account has one.
 */
export function SubscriptionSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const trial = account.trialUsageLimit > 0;
  return (
    <SectionCard icon={CreditCardIcon} slim title={t("detail.subscription")}>
      <PropertyList>
        <PropertyRow label={t("detail.plan")} value={planLabel(account, t)} />
        <PropertyRow
          label={t("detail.tokenExpiry")}
          value={account.expiresAt ? formatDateTime(account.expiresAt, lang) : ""}
        />
        <PropertyRow
          label={t("detail.resetDate")}
          value={formatResetDate(account.nextResetDate, lang)}
        />
        {trial ? (
          <>
            <PropertyRow
              label={t("detail.trialCredits")}
              value={credits(account.trialUsageCurrent, account.trialUsageLimit, lang)}
            />
            <PropertyRow label={t("detail.trialStatus")} value={account.trialStatus} />
            <PropertyRow
              label={t("detail.trialExpiry")}
              value={account.trialExpiresAt ? formatDateTime(account.trialExpiresAt, lang) : ""}
            />
          </>
        ) : null}
      </PropertyList>
    </SectionCard>
  );
}

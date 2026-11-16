import { ChartColumnIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { UsageBreakdownCard } from "@/features/api/key-usage-breakdown";
import {
  UsageChartCard,
  UsageRangeControl,
  UsageTotalsStrip,
} from "@/features/api/key-usage-sheet";
import { type UserUsageRange, userUsageBreakdownQuery, userUsageQuery } from "@/lib/api/user-panel";
import { useT } from "@/lib/i18n";

/**
 * The key's usage over 24 hours, 7 or 30 days or its lifetime, built from the admin usage sheet's
 * parts: the range switch over the headline numbers, then the chart (requests, tokens or credits)
 * beside the usage by model. One range drives all three.
 */
export function UsageSection(): JSX.Element {
  const { t } = useT("user-panel");
  const [range, setRange] = useState<UserUsageRange>("24h");
  const usage = useQuery(userUsageQuery(range));
  const breakdown = useQuery(userUsageBreakdownQuery(range));
  const data = usage.data;
  // Only this key's entry; none when the range has no traffic.
  const entry = data?.keys.find((candidate) => candidate.kind === "key") ?? data?.keys[0];

  return (
    <>
      <SectionCard
        actions={<UsageRangeControl onValueChange={setRange} value={range} />}
        description={t(`usage.range.${range}`)}
        descriptionVariant="inline"
        icon={ChartColumnIcon}
        id="user-usage"
        slim
        title={t("usage.title")}
      >
        {/* As in the usage sheet, the numbers stay bars until the range loads. A failure shows
            in the chart card below, with its Retry; here the bars give way to "Not loaded". */}
        {usage.isError && !data ? (
          <ErrorState notLoaded />
        ) : (
          <UsageTotalsStrip loading={!data} totals={entry?.totals ?? data?.totals} />
        )}
      </SectionCard>
      <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <UsageChartCard
          data={data}
          entry={entry}
          error={usage.error}
          isError={usage.isError}
          onRetry={() => void usage.refetch()}
          range={range}
          retrying={usage.isFetching}
        />
        <UsageBreakdownCard
          error={breakdown.error}
          loading={breakdown.isPending}
          models={breakdown.data?.models}
          onRetry={() => void breakdown.refetch()}
          retrying={breakdown.isFetching}
          showAccounts={false}
          title={t("models.title")}
        />
      </div>
    </>
  );
}

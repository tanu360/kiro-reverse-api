import { useQuery } from "@tanstack/react-query";
import { type JSX, useId, useState } from "react";
import { UsageBreakdownCard } from "@/features/api/key-usage-breakdown";
import { UsageChartCard, UsageRangeControl } from "@/features/api/key-usage-sheet";
import {
  type UserKey,
  type UserUsageRange,
  userUsageBreakdownQuery,
  userUsageQuery,
} from "@/lib/api/user-panel";
import { useT } from "@/lib/i18n";
import { KeyFacts } from "./key-facts";
import { UsageKpis } from "./usage-kpis";

/**
 * The key's usage over 24 hours, 7 or 30 days or its lifetime: the range switch over the
 * Overview's KPI cards (each with the key's limit for its measure), the key's settings in one
 * strip, then the admin usage sheet's chart (requests, tokens or credits) beside the usage by
 * model. One range drives the cards and both charts.
 */
export function UsageSection({ apiKey }: { apiKey: UserKey | undefined }): JSX.Element {
  const { t } = useT("user-panel");
  const headingId = useId();
  const [range, setRange] = useState<UserUsageRange>("24h");
  const usage = useQuery(userUsageQuery(range));
  const breakdown = useQuery(userUsageBreakdownQuery(range));
  const data = usage.data;
  // Only this key's entry; none when the range has no traffic.
  const entry = data?.keys.find((candidate) => candidate.kind === "key") ?? data?.keys[0];

  return (
    <>
      {/* The KPI cards take the Overview's columns, which follow this container's width. */}
      <div className="@container/main flex min-w-0 flex-col gap-4">
        <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <h2 className="font-semibold text-foreground text-heading" id={headingId}>
                {t("usage.title")}
              </h2>
              <span className="text-muted-foreground text-sm">{t(`usage.range.${range}`)}</span>
            </div>
            <UsageRangeControl onValueChange={setRange} value={range} />
          </div>
          <UsageKpis
            apiKey={apiKey}
            entry={entry}
            isError={usage.isError}
            range={range}
            usage={data}
          />
        </section>
        <KeyFacts apiKey={apiKey} />
      </div>
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

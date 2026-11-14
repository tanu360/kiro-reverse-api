import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, Suspense, useId, useState } from "react";
import { Skeleton as SkulletSkeleton } from "skullet/react";
import { ChartSkeleton } from "@/components/shared/chart-skeleton";
import { CreditAmount } from "@/components/shared/credit-amount";
import { StatStrip, type StatStripItem } from "@/components/shared/stat-strip";
import { Card } from "@/components/ui/card";
import { heatmapQuery } from "@/lib/api/observe";
import type { Account, HeatmapCell } from "@/lib/api/types";
import { formatCompact, formatNumber, formatPercent, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LiveActivityStrip } from "../account-activity";
import { UsageMeter } from "../account-cells";
import { ForecastLine } from "../account-forecast";
import { formatCreditAmount, formatResetDate, resetDateSec } from "../account-model";

/** 24 one-hour buckets: the account's last day of traffic. */
const HOURS = 24;
/** The area chart's height in px. */
const CHART_HEIGHT = 48;

const ActivityChart = lazy(() => import("./activity-chart"));

/**
 * The sheet's opening card: the credits meter (plan, or trial for a trial-only account) with the
 * reset date, the last 24 hours of requests, today's and the last minute's requests, then the
 * four lifetime numbers. Four across from a 28rem card, two by two below it (a phone sheet). The
 * section keeps the "Statistics" name for screen readers; the numbers carry their own labels.
 */
export function StatisticsSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const headingId = useId();
  const hasUsage = account.usageLimit > 0 || account.trialUsageLimit > 0;
  const resetSec = account.usageLimit > 0 ? resetDateSec(account.nextResetDate) : null;
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
          {resetSec !== null ? (
            <p className="mt-2 text-meta text-muted-foreground">
              {t("detail.resets", {
                date: formatResetDate(account.nextResetDate, lang),
                relative: formatRelativeTime(resetSec, lang),
              })}
            </p>
          ) : null}
          {account.usageLimit > 0 ? <ForecastLine accountId={account.id} className="mt-1" /> : null}
        </div>
      ) : null}
      <ActivityStrip
        accountId={account.id}
        className={cn(hasUsage && "border-border-subtle border-t")}
      />
      <LiveActivityStrip accountId={account.id} className="border-border-subtle border-t" />
      <StatStrip className="border-border-subtle border-t" items={stats} />
    </Card>
  );
}

/**
 * The account's requests over the last 24 hours as an area chart, oldest on the left, failures
 * in red along its foot, from the same per-account heatmap as the Overview (hourly buckets,
 * polled once a minute). The line above gives the day's count and success rate, or the hovered
 * hour's numbers while the pointer is on the chart. Left out when the heatmap cannot load: the
 * lifetime numbers below still stand.
 */
function ActivityStrip({
  accountId,
  className,
}: {
  accountId: string;
  className?: string;
}): JSX.Element | null {
  const { t, lang } = useT("accounts");
  const query = useQuery(heatmapQuery(HOURS * 60, { bucketMin: 60, live: false }));
  const [hovered, setHovered] = useState<number | null>(null);
  if (query.isError) return null;

  const row = query.data?.accounts.find((item) => item.accountId === accountId);
  // Offset 0 is the current hour: reverse so the newest point is on the right.
  const cells: HeatmapCell[] = row
    ? row.cells.slice(0, HOURS).reverse()
    : Array.from({ length: HOURS }, (_, index) => ({
        offset: HOURS - 1 - index,
        reqs: 0,
        failures: 0,
      }));
  const total = cells.reduce((sum, cell) => sum + cell.reqs, 0);
  const failures = cells.reduce((sum, cell) => sum + cell.failures, 0);
  const point = hovered === null ? undefined : cells[hovered];

  let summary: string;
  if (point) {
    const when = formatRelativeTime(Date.now() / 1000 - point.offset * 3600, lang);
    const requests = formatNumber(point.reqs, lang);
    summary =
      point.failures > 0
        ? t("detail.activityPointFailed", {
            when,
            requests,
            failures: formatNumber(point.failures, lang),
          })
        : t("detail.activityPoint", { when, requests });
  } else {
    summary =
      total > 0
        ? t("detail.activitySummary", {
            requests: formatNumber(total, lang),
            rate: formatPercent(total - failures, total, lang),
          })
        : t("detail.activityNone");
  }

  // Shaped like the chart it holds the place of, not a flat block.
  const placeholder = <ChartSkeleton style={{ height: CHART_HEIGHT }} />;
  return (
    <div className={cn("px-4 py-3.5 sm:px-6", className)}>
      <div className="flex items-baseline justify-between gap-3 text-meta text-muted-foreground">
        <span>{t("detail.activity")}</span>
        {/* skullet measures the line it will show (the empty day's summary while it loads), so
            the bar has the text's own width and the row does not move when it lands. */}
        <SkulletSkeleton label={t("detail.activity")} loading={query.isPending}>
          <span className="truncate tabular-nums">{summary}</span>
        </SkulletSkeleton>
      </div>
      <div className="mt-2">
        {query.isPending ? (
          placeholder
        ) : (
          <Suspense fallback={placeholder}>
            <ActivityChart
              data={cells}
              height={CHART_HEIGHT}
              idle={total === 0}
              onHover={setHovered}
            />
          </Suspense>
        )}
      </div>
      <div
        aria-hidden="true"
        className="mt-1.5 flex justify-between text-meta text-muted-foreground"
      >
        <span>{t("detail.activityStart")}</span>
        <span>{t("detail.activityEnd")}</span>
      </div>
    </div>
  );
}

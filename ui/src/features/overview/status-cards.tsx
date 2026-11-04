import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, RouteIcon, UsersIcon } from "lucide-react";
import { type JSX, lazy, Suspense, useMemo } from "react";
import { StatCardSkeleton } from "@/components/shared/loading-state";
import { StatCard, type StatCardProps, type StatMetric } from "@/components/shared/stat-card";
import { heatmapQuery } from "@/lib/api/observe";
import { statusQuery } from "@/lib/api/system";
import type { HeatmapCell, StatusResponse } from "@/lib/api/types";
import { EMPTY, formatCompact, formatCredits, formatNumber, formatPercent } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { type CellValue, HOUR_PAIR_WINDOW, hourDelta, sparklineBuckets } from "./aggregate";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const StatSparkline = lazy(() => import("./stat-sparkline"));

// Columns follow the page's content width (@container/main), not the viewport: a card needs
// about 20rem for its two metric columns, so two cards per row start at 42rem.
const GRID_CLASS = "grid grid-cols-1 gap-4 @2xl/main:grid-cols-2 @5xl/main:grid-cols-4";

/** Titles kept on the cards while /status has failed; the page shows one error banner. */
const PLACEHOLDERS: readonly (Pick<StatCardProps, "icon" | "tone"> & { label: string })[] = [
  { icon: UsersIcon, label: "stats.accounts" },
  { icon: RouteIcon, label: "stats.requests" },
  { icon: CircleCheckIcon, label: "stats.success" },
  { icon: CircleXIcon, label: "stats.failed", tone: "danger" },
];

const succeeded: CellValue = (cell) => Math.max(0, cell.reqs - cell.failures);
const failures: CellValue = (cell) => cell.failures;
const requests: CellValue = (cell) => cell.reqs;

interface Trend {
  delta: StatCardProps["delta"];
  sparkline: StatCardProps["sparkline"];
}

const NO_TREND: Trend = { delta: null, sparkline: undefined };

function trendFor(
  cells: readonly HeatmapCell[],
  value: CellValue,
  options: { color: string; goodWhen: "up" | "down"; label: string; animate: boolean },
): Trend {
  const { delta } = hourDelta(cells, value);
  return {
    delta:
      delta === null ? null : { value: delta, label: options.label, goodWhen: options.goodWhen },
    sparkline: (
      <Suspense fallback={null}>
        <StatSparkline
          animate={options.animate}
          color={options.color}
          data={sparklineBuckets(cells, value)}
        />
      </Suspense>
    ),
  };
}

function ratio(part: number, total: number, lang: Lang): string {
  return `${formatNumber(part, lang)} / ${formatNumber(total, lang)}`;
}

/** A rate of all requests; with no requests yet there is no rate, so a muted dash. */
function requestRate(
  part: number,
  total: number,
  tone: StatMetric["tone"] = "default",
): Pick<StatMetric, "value" | "tone"> {
  if (total <= 0) return { value: EMPTY, tone: "muted" };
  return { value: formatPercent(part, total), tone };
}

function accountsCard(s: StatusResponse, t: TFunction, lang: Lang): StatCardProps {
  return {
    icon: UsersIcon,
    label: t("stats.accounts"),
    value: formatNumber(s.accounts, lang),
    metrics: [
      { label: t("stats.available"), value: ratio(s.available, s.accounts, lang), wrap: true },
      {
        label: t("stats.capacityUsed"),
        value: formatPercent(s.accountCreditsUsed, s.accountCreditsLimit),
      },
      {
        label: t("stats.accountCredits"),
        value: `${formatCredits(s.accountCreditsUsed, 1, lang)} / ${formatCredits(s.accountCreditsLimit, 1, lang)}`,
        hint: t("stats.accountCreditsHint"),
        wide: true,
        wrap: true,
      },
      {
        label: t("stats.otherCredits"),
        value: formatCredits(Math.max(0, s.accountCreditsUsed - s.totalCredits), 1, lang),
        hint: t("stats.otherCreditsHint"),
        wide: true,
      },
    ],
  };
}

function requestsCard(s: StatusResponse, t: TFunction, lang: Lang): StatCardProps {
  const total = s.totalRequests;
  return {
    icon: RouteIcon,
    label: t("stats.requests"),
    value: formatNumber(total, lang),
    caption: t("stats.sinceReset"),
    metrics: [
      { label: t("stats.tokens"), value: formatCompact(s.totalTokens) },
      {
        label: t("stats.appCredits"),
        value: formatCredits(s.totalCredits, 1, lang),
        hint: t("stats.appCreditsHint"),
      },
      { label: t("stats.avgTokens"), value: formatCompact(total > 0 ? s.totalTokens / total : 0) },
      {
        label: t("stats.avgCredits"),
        value: formatCredits(total > 0 ? s.totalCredits / total : 0, 1, lang),
      },
    ],
  };
}

function succeededCard(s: StatusResponse, t: TFunction, lang: Lang): StatCardProps {
  return {
    icon: CircleCheckIcon,
    label: t("stats.success"),
    value: formatNumber(s.successRequests, lang),
    caption: t("stats.sinceReset"),
    metrics: [
      {
        label: t("stats.successRate"),
        ...requestRate(s.successRequests, s.totalRequests),
      },
      {
        label: t("stats.completed"),
        value: ratio(s.successRequests, s.totalRequests, lang),
        wrap: true,
      },
      { label: t("stats.inputTokens"), value: formatCompact(s.successInTokens) },
      { label: t("stats.outputTokens"), value: formatCompact(s.successOutTokens) },
    ],
  };
}

function failedCard(s: StatusResponse, t: TFunction, lang: Lang): StatCardProps {
  return {
    icon: CircleXIcon,
    tone: "danger",
    label: t("stats.failed"),
    value: formatNumber(s.failedRequests, lang),
    caption: t("stats.sinceReset"),
    metrics: [
      {
        label: t("stats.failedRate"),
        ...requestRate(s.failedRequests, s.totalRequests, "danger"),
      },
      { label: t("stats.errorEvents"), value: formatNumber(s.totalErrorEvents, lang) },
      { label: t("stats.exhausted"), value: formatNumber(s.totalExhausted, lang) },
      {
        label: t("stats.unavailable"),
        value: formatNumber(Math.max(0, s.accounts - s.available), lang),
      },
    ],
  };
}

/** The four /status cards. Requests, Succeeded and Failed add an hour-over-hour trend. */
export function StatusCards(): JSX.Element {
  const { t, lang } = useT("overview");
  const status = useQuery(statusQuery());
  // Shared with the account heatmap (same key), so this costs no extra request.
  const heatmap = useQuery(heatmapQuery(HOUR_PAIR_WINDOW));
  const animate = !usePrefersReducedMotion();
  const cells = heatmap.data?.global.cells;
  const label = t("stats.vsPreviousHour");

  // Recomputed only when the heatmap changes, so the sparklines do not re-animate on polls.
  const trends = useMemo(() => {
    if (!cells) return { requests: NO_TREND, succeeded: NO_TREND, failed: NO_TREND };
    const primary = "var(--chart-line-primary)";
    return {
      requests: trendFor(cells, requests, { color: primary, goodWhen: "up", label, animate }),
      succeeded: trendFor(cells, succeeded, { color: primary, goodWhen: "up", label, animate }),
      failed: trendFor(cells, failures, {
        color: "var(--chart-negative)",
        goodWhen: "down",
        label,
        animate,
      }),
    };
  }, [cells, label, animate]);

  const data = status.data;
  if (!data) {
    if (status.isError) {
      // The error and its Retry live in the page banner (OverviewPage), shown once.
      return (
        <section aria-label={t("stats.label")} className={GRID_CLASS} data-state="error">
          {PLACEHOLDERS.map((card) => (
            <StatCard
              icon={card.icon}
              key={card.label}
              label={t(card.label)}
              tone={card.tone}
              value={EMPTY}
            />
          ))}
        </section>
      );
    }
    return (
      <section aria-busy="true" aria-label={t("stats.label")} className={GRID_CLASS}>
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <StatCardSkeleton key={index} />
        ))}
      </section>
    );
  }

  // A failed background refetch keeps the last values; the page banner reports it.
  return (
    <section aria-label={t("stats.label")} className={GRID_CLASS}>
      <StatCard {...accountsCard(data, t, lang)} />
      <StatCard {...requestsCard(data, t, lang)} {...trends.requests} />
      <StatCard {...succeededCard(data, t, lang)} {...trends.succeeded} />
      <StatCard {...failedCard(data, t, lang)} {...trends.failed} />
    </section>
  );
}

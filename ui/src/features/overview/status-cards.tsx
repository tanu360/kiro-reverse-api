import { CircleCheckIcon, CircleXIcon, Route01Icon, UsersIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, type ReactNode, Suspense, useMemo } from "react";
import {
  StatGroup,
  type StatMetric,
  StatTile,
  type StatTileProps,
  StatTileSkeleton,
} from "@/components/shared/stat-card";
import { Meter, MeterIndicator, type MeterTone, MeterTrack } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery, observeOverviewQuery } from "@/lib/api/observe";
import { statusQuery } from "@/lib/api/system";
import type { HeatmapCell, StatusResponse } from "@/lib/api/types";
import { EMPTY, formatCompact, formatCredits, formatNumber, formatPercent } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { type CellValue, HOUR_PAIR_WINDOW, hourDelta, sparklineBuckets } from "./aggregate";
import { FAILED_COLOR } from "./colors";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const StatSparkline = lazy(() => import("./stat-sparkline"));

/**
 * True while /status or /observe/overview has failed: the page shows one error banner with the
 * Retry for every card, and the section cards drop their own error blocks to a quiet
 * "Not loaded" line.
 */
export function useTotalsFailed(): boolean {
  // Same query keys as the cards, so these observers add no requests.
  const status = useQuery(statusQuery());
  const live = useQuery(observeOverviewQuery());
  return status.isError || live.isError;
}

/** Titles kept on the tiles while /status has failed; the page shows one error banner. */
const PLACEHOLDERS: readonly (Pick<StatTileProps, "icon"> & { label: string })[] = [
  { icon: UsersIcon, label: "stats.accounts" },
  { icon: Route01Icon, label: "stats.requests" },
  { icon: CircleCheckIcon, label: "stats.success" },
  { icon: CircleXIcon, label: "stats.failed" },
];

const succeeded: CellValue = (cell) => Math.max(0, cell.reqs - cell.failures);
const failures: CellValue = (cell) => cell.failures;
const requests: CellValue = (cell) => cell.reqs;

type Trend = Pick<StatTileProps, "delta" | "trend">;

function trendFor(
  cells: readonly HeatmapCell[],
  value: CellValue,
  options: { goodWhen: "up" | "down"; label: string; animate: boolean },
): Trend {
  const { current, previous, delta } = hourDelta(cells, value);
  // The newest bar turns red only on the Failed tile, and only when failures are up.
  const alert = options.goodWhen === "down" && current > previous;
  return {
    delta:
      delta === null ? null : { value: delta, label: options.label, goodWhen: options.goodWhen },
    trend: (
      <Suspense fallback={null}>
        <StatSparkline
          animate={options.animate}
          color={alert ? FAILED_COLOR : undefined}
          data={sparklineBuckets(cells, value)}
        />
      </Suspense>
    ),
  };
}

/** While the heatmap loads, the trend slot holds its 28 px with a placeholder. */
const PENDING_TREND: Trend = { delta: null, trend: <Skeleton className="h-7 w-full" /> };
const NO_TREND: Trend = { delta: null, trend: undefined };

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

/** The capacity meter fills purple, amber from 80 % and red from 95 % (nearly out of credits). */
function capacityTone(used: number, limit: number): MeterTone {
  const share = used / limit;
  if (share >= 0.95) return "destructive";
  if (share >= 0.8) return "warning";
  return "default";
}

/** Plan credits used across the pool as a thin meter, and "x% capacity used" beside it. */
function capacity(s: StatusResponse, t: TFunction): Pick<StatTileProps, "caption" | "trend"> {
  // No plan limit reported yet: no rate, so the muted dash (as requestRate).
  if (s.accountCreditsLimit <= 0) {
    return { caption: t("stats.capacityCaption", { value: EMPTY }) };
  }
  const value = formatPercent(s.accountCreditsUsed, s.accountCreditsLimit);
  const meter: ReactNode = (
    <div className="flex h-full items-end pb-1">
      <Meter
        max={s.accountCreditsLimit}
        min={0}
        value={Math.min(s.accountCreditsUsed, s.accountCreditsLimit)}
      >
        <MeterTrack>
          <MeterIndicator tone={capacityTone(s.accountCreditsUsed, s.accountCreditsLimit)} />
        </MeterTrack>
      </Meter>
    </div>
  );
  return { caption: t("stats.capacityCaption", { value }), trend: meter };
}

function accountsTile(s: StatusResponse, t: TFunction, lang: Lang): StatTileProps {
  return {
    icon: UsersIcon,
    label: t("stats.accounts"),
    value: formatNumber(s.accounts, lang),
    ...capacity(s, t),
    metrics: [
      { label: t("stats.available"), value: ratio(s.available, s.accounts, lang), wrap: true },
      {
        label: t("stats.otherCredits"),
        value: formatCredits(Math.max(0, s.accountCreditsUsed - s.totalCredits), 1, lang),
        hint: t("stats.otherCreditsHint"),
      },
      {
        label: t("stats.accountCredits"),
        value: `${formatCredits(s.accountCreditsUsed, 1, lang)} / ${formatCredits(s.accountCreditsLimit, 1, lang)}`,
        hint: t("stats.accountCreditsHint"),
        wide: true,
        wrap: true,
      },
    ],
  };
}

function requestsTile(s: StatusResponse, t: TFunction, lang: Lang): StatTileProps {
  const total = s.totalRequests;
  return {
    icon: Route01Icon,
    label: t("stats.requests"),
    value: formatNumber(total, lang),
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

function succeededTile(s: StatusResponse, t: TFunction, lang: Lang): StatTileProps {
  return {
    icon: CircleCheckIcon,
    label: t("stats.success"),
    value: formatNumber(s.successRequests, lang),
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

function failedTile(s: StatusResponse, t: TFunction, lang: Lang): StatTileProps {
  return {
    icon: CircleXIcon,
    // Red marks the icon only, and only once something has failed; the value keeps its colour.
    tone: s.failedRequests > 0 ? "danger" : "default",
    label: t("stats.failed"),
    value: formatNumber(s.failedRequests, lang),
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

/**
 * The four /status totals as one joined KPI strip. Requests, Succeeded and Failed add an
 * hour-over-hour delta and a bar sparkline; Accounts shows the plan capacity used.
 */
export function StatusCards(): JSX.Element {
  const { t, lang } = useT("overview");
  const status = useQuery(statusQuery());
  // Shared with the account heatmap (same key), so this costs no extra request.
  const heatmap = useQuery(heatmapQuery(HOUR_PAIR_WINDOW));
  const animate = !usePrefersReducedMotion();
  const cells = heatmap.data?.global.cells;
  const pending = heatmap.isPending;
  const label = t("stats.vsPreviousHour");

  // Recomputed only when the heatmap changes, so the sparklines do not re-animate on polls.
  const trends = useMemo(() => {
    if (!cells) {
      const fallback = pending ? PENDING_TREND : NO_TREND;
      return { requests: fallback, succeeded: fallback, failed: fallback };
    }
    return {
      requests: trendFor(cells, requests, { goodWhen: "up", label, animate }),
      succeeded: trendFor(cells, succeeded, { goodWhen: "up", label, animate }),
      failed: trendFor(cells, failures, { goodWhen: "down", label, animate }),
    };
  }, [cells, pending, label, animate]);

  const data = status.data;
  let strip: JSX.Element;
  if (!data && status.isError) {
    // The error and its Retry live in the page banner (OverviewPage), shown once.
    strip = (
      <StatGroup columns="kpi" joined>
        {PLACEHOLDERS.map((tile) => (
          <StatTile icon={tile.icon} key={tile.label} label={t(tile.label)} value={EMPTY} />
        ))}
      </StatGroup>
    );
  } else if (!data) {
    strip = (
      <StatGroup aria-hidden="true" columns="kpi" joined>
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <StatTileSkeleton key={index} metrics={4} />
        ))}
      </StatGroup>
    );
  } else {
    // A failed background refetch keeps the last values; the page banner reports it.
    strip = (
      <StatGroup columns="kpi" joined>
        <StatTile {...accountsTile(data, t, lang)} />
        <StatTile {...requestsTile(data, t, lang)} {...trends.requests} />
        <StatTile {...succeededTile(data, t, lang)} {...trends.succeeded} />
        <StatTile {...failedTile(data, t, lang)} {...trends.failed} />
      </StatGroup>
    );
  }

  return (
    <section
      aria-busy={!data && !status.isError ? true : undefined}
      aria-label={t("stats.label")}
      className="flex min-w-0 flex-col gap-2"
      data-state={!data && status.isError ? "error" : undefined}
    >
      {strip}
      <p className="text-meta text-muted-foreground">{t("stats.sinceReset")}</p>
    </section>
  );
}

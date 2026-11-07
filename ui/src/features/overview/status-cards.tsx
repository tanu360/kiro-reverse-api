import { CircleCheckIcon, CircleXIcon, Route01Icon, UsersIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode, useMemo } from "react";
import {
  STAT_TREND_HEIGHT,
  type StatDelta,
  StatGroup,
  type StatMetric,
  StatTile,
  type StatTileProps,
  StatTileSkeleton,
} from "@/components/shared/stat-card";
import { Meter, MeterIndicator, type MeterTone, MeterTrack } from "@/components/ui/meter";
import { heatmapQuery, observeOverviewQuery } from "@/lib/api/observe";
import { statusQuery } from "@/lib/api/system";
import type { HeatmapCell, ObserveSeries, StatusResponse } from "@/lib/api/types";
import { EMPTY, formatCompact, formatCredits, formatNumber, formatPercent } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { type Bars, type CellValue, HOUR_PAIR_WINDOW, hourDelta, outcomeBars } from "./aggregate";
import { FAILED_COLOR } from "./colors";
import { LazySparkline, TrendPlaceholder } from "./lazy-sparkline";
import { usePrefersReducedMotion } from "./use-reduced-motion";

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

/**
 * The newest bars drawn in the series colour: three 2-minute bars, about the last five minutes
 * (the reference strip's bright tail). The older bars are the idle grey.
 */
const HIGHLIGHT_BARS = 3;

type TrendKey = "requests" | "succeeded" | "failed";
type Trends = Record<TrendKey, Pick<StatTileProps, "delta" | "trend">>;

/** The hour-over-hour change from the cached two-hour heatmap ("+6.8% vs last hour"). */
function deltaFor(
  cells: readonly HeatmapCell[] | undefined,
  value: CellValue,
  goodWhen: StatDelta["goodWhen"],
  label: string,
): StatDelta | null {
  if (!cells) return null;
  const { delta } = hourDelta(cells, value);
  return delta === null ? null : { value: delta, label, goodWhen };
}

/**
 * The trend slots: 15 two-minute bars of the last half hour from the live series (shared with
 * the live tiles, so no extra request). The Failed bars are red, and only while the newest ones
 * hold failures; otherwise they all stay grey.
 */
function barTrends(series: Partial<ObserveSeries>, animate: boolean): Record<TrendKey, ReactNode> {
  const bars = outcomeBars(series.rpm ?? [], series.errRate ?? []);
  const failing = bars.failed.slice(-HIGHLIGHT_BARS).some((bar) => bar.value > 0);
  const sparkline = (data: Bars, color?: string, highlight = HIGHLIGHT_BARS) => (
    <LazySparkline
      animate={animate}
      color={color}
      data={data}
      height={STAT_TREND_HEIGHT.aside}
      highlight={highlight}
    />
  );
  return {
    requests: sparkline(bars.requests),
    succeeded: sparkline(bars.succeeded),
    failed: sparkline(bars.failed, FAILED_COLOR, failing ? HIGHLIGHT_BARS : 0),
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

/** The capacity meter fills purple, amber from 80 % and red from 95 % (nearly out of credits). */
function capacityTone(used: number, limit: number): MeterTone {
  const share = used / limit;
  if (share >= 0.95) return "destructive";
  if (share >= 0.8) return "warning";
  return "default";
}

/**
 * Plan credits used across the pool as a thin meter, centred in the aside trend slot the other
 * tiles draw their bars in, and "x% capacity used" on the delta line.
 */
function capacity(s: StatusResponse, t: TFunction): Pick<StatTileProps, "caption" | "trend"> {
  // No plan limit reported yet: no rate, so the muted dash (as requestRate).
  if (s.accountCreditsLimit <= 0) {
    return { caption: t("stats.capacityCaption", { value: EMPTY }) };
  }
  const value = formatPercent(s.accountCreditsUsed, s.accountCreditsLimit);
  const meter: ReactNode = (
    <div className="flex h-full items-center">
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
 * The four /status totals as one joined KPI strip, like the reference's top row: icon and label,
 * the big number, a delta line, and a bar sparkline in a column beside the number and the delta
 * (the aside trend). Requests, Succeeded and Failed compare this hour with the previous one and
 * draw the last half hour as bars; Accounts shows the plan capacity used as a meter in the same
 * slot.
 */
export function StatusCards(): JSX.Element {
  const { t, lang } = useT("overview");
  const status = useQuery(statusQuery());
  // Only the global row is read, so the accounts stay off the wire. Shared with the traffic
  // chart's 1 h view (same key), so this costs no extra request.
  const heatmap = useQuery(heatmapQuery(HOUR_PAIR_WINDOW, { scope: "global" }));
  // The live series behind the bars; same key as the live tiles, so no extra request.
  const live = useQuery(observeOverviewQuery());
  const animate = !usePrefersReducedMotion();
  const cells = heatmap.data?.global.cells;
  const overview = live.data;
  const livePending = live.isPending;
  const label = t("stats.vsLastHour");

  // Rebuilt only when the heatmap or a live tick brings new numbers, so the bars morph in place
  // instead of re-entering on every render.
  const trends = useMemo<Trends>(() => {
    let nodes: Partial<Record<TrendKey, ReactNode>> = {};
    if (overview) {
      // An older server sends no series: the bars then draw as the flat empty stubs.
      nodes = barTrends(overview.series ?? {}, animate);
    } else if (livePending) {
      // Until the series loads, the aside slot holds a placeholder, so nothing shifts.
      const pending = <TrendPlaceholder />;
      nodes = { requests: pending, succeeded: pending, failed: pending };
    }
    // A failed load leaves the slots empty; the page banner reports it.
    return {
      requests: { delta: deltaFor(cells, requests, "up", label), trend: nodes.requests },
      succeeded: { delta: deltaFor(cells, succeeded, "up", label), trend: nodes.succeeded },
      failed: { delta: deltaFor(cells, failures, "down", label), trend: nodes.failed },
    };
  }, [cells, overview, livePending, label, animate]);

  const data = status.data;
  let strip: JSX.Element;
  if (!data && status.isError) {
    // The error and its Retry live in the page banner (OverviewPage), shown once.
    strip = (
      <StatGroup columns="kpi" joined>
        {PLACEHOLDERS.map((tile) => (
          <StatTile
            icon={tile.icon}
            key={tile.label}
            label={t(tile.label)}
            trendPlacement="aside"
            value={EMPTY}
          />
        ))}
      </StatGroup>
    );
  } else if (!data) {
    strip = (
      <StatGroup aria-hidden="true" columns="kpi" joined>
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <StatTileSkeleton key={index} metrics={4} trendPlacement="aside" />
        ))}
      </StatGroup>
    );
  } else {
    // A failed background refetch keeps the last values; the page banner reports it.
    strip = (
      <StatGroup columns="kpi" joined>
        <StatTile {...accountsTile(data, t, lang)} trendPlacement="aside" />
        <StatTile {...requestsTile(data, t, lang)} {...trends.requests} trendPlacement="aside" />
        <StatTile {...succeededTile(data, t, lang)} {...trends.succeeded} trendPlacement="aside" />
        <StatTile {...failedTile(data, t, lang)} {...trends.failed} trendPlacement="aside" />
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
      {/* The strip's heading: close over the totals it qualifies, the page's 16 px beat above. */}
      <p className="text-meta text-muted-foreground">{t("stats.sinceReset")}</p>
      {strip}
    </section>
  );
}

import {
  Activity01Icon,
  AlertCircleIcon,
  Coins01Icon,
  Download04Icon,
  Upload04Icon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, type ReactNode, Suspense, useMemo } from "react";
import {
  StatGroup,
  StatTile,
  type StatTileProps,
  StatTileSkeleton,
} from "@/components/shared/stat-card";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { observeOverviewQuery } from "@/lib/api/observe";
import type { ObserveOverview, ObserveSeries } from "@/lib/api/types";
import { EMPTY, formatCredits, formatFraction, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { FAILED_COLOR } from "./colors";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const StatSparkline = lazy(() => import("./stat-sparkline"));

type TileId = "rpm" | "errRate" | "inTpm" | "outTpm" | "credits60" | "activeAccounts";

interface Tile {
  id: TileId;
  icon: StatTileProps["icon"];
  label: string;
  hint?: string;
}

function tiles(t: TFunction): Tile[] {
  return [
    { id: "rpm", icon: Activity01Icon, label: t("live.rpm") },
    { id: "errRate", icon: AlertCircleIcon, label: t("live.errRate") },
    { id: "inTpm", icon: Download04Icon, label: t("live.inTpm") },
    { id: "outTpm", icon: Upload04Icon, label: t("live.outTpm") },
    { id: "credits60", icon: Coins01Icon, label: t("live.credits60") },
    {
      id: "activeAccounts",
      icon: UserCheck01Icon,
      label: t("live.activeAccounts"),
      hint: t("live.activeAccountsHint"),
    },
  ];
}

function values(o: ObserveOverview, lang: Lang): Record<TileId, string> {
  return {
    rpm: formatNumber(o.rpm1, lang),
    errRate: formatFraction(o.errRate5, 1, lang),
    inTpm: formatNumber(Math.round(o.inTpm5), lang),
    outTpm: formatNumber(Math.round(o.outTpm5), lang),
    credits60: formatCredits(o.credits60, 2, lang),
    activeAccounts: `${formatNumber(o.activeAccts, lang)} / ${formatNumber(o.availableAccts ?? 0, lang)}`,
  };
}

/**
 * Minutes per sparkline bar: the 30 per-minute points become 15 bars, wide enough to read in
 * the 48 to 96 px trend slot. Bars are cut from the newest end, so the last one always holds the
 * current (partial) minute.
 */
const BAR_MINUTES = 2;

type Bars = { value: number }[];

/** Sums `values` (oldest first) into BAR_MINUTES-wide bars, oldest first. */
function sumBars(values: readonly number[]): Bars {
  const bars: Bars = [];
  for (let end = values.length; end > 0; end -= BAR_MINUTES) {
    let sum = 0;
    for (let index = Math.max(0, end - BAR_MINUTES); index < end; index += 1) {
      sum += values[index] ?? 0;
    }
    bars.unshift({ value: sum });
  }
  return bars;
}

/** The error rate per bar: failures over requests across its minutes (0 for an empty bar). */
function rateBars(rpm: readonly number[], errRate: readonly number[]): Bars {
  const requests = sumBars(rpm);
  const failures = sumBars(rpm.map((reqs, index) => reqs * (errRate[index] ?? 0)));
  return requests.map((bar, index) => ({
    value: bar.value > 0 ? failures[index].value / bar.value : 0,
  }));
}

/** Older servers send no series; every tile then shows the flat empty stubs. */
const NO_SERIES: ObserveSeries = { rpm: [], errRate: [], inTpm: [], outTpm: [], credits: [] };

function trends(o: ObserveOverview, animate: boolean): Record<TileId, ReactNode> {
  const series = o.series ?? NO_SERIES;
  const errRate = rateBars(series.rpm ?? [], series.errRate ?? []);
  const last = errRate.at(-1)?.value ?? 0;
  const before = errRate.at(-2)?.value ?? 0;
  const sparkline = (data: Bars, color?: string) => (
    <Suspense fallback={null}>
      <StatSparkline animate={animate} color={color} data={data} />
    </Suspense>
  );
  // Active accounts has no series: a meter of the active share of the available accounts.
  const available = Math.max(0, o.availableAccts ?? 0);
  const meter = (
    <div className="flex h-full items-end pb-1">
      <Meter max={Math.max(1, available)} min={0} value={Math.min(o.activeAccts, available)}>
        <MeterTrack>
          <MeterIndicator />
        </MeterTrack>
      </Meter>
    </div>
  );
  return {
    rpm: sparkline(sumBars(series.rpm ?? [])),
    // The newest bar turns red only while the error rate is rising.
    errRate: sparkline(errRate, last > before ? FAILED_COLOR : undefined),
    inTpm: sparkline(sumBars(series.inTpm ?? [])),
    outTpm: sparkline(sumBars(series.outTpm ?? [])),
    credits60: sparkline(sumBars(series.credits ?? [])),
    activeAccounts: meter,
  };
}

/**
 * Six live tiles from /observe/overview, refreshed by SSE observe ticks: separate StatTile cards
 * with the KPI strip's anatomy (icon and label, 24 px value, and a bar sparkline of the last
 * 30 minutes in the trend row; Active accounts shows a meter of the available accounts there).
 */
export function LiveTiles(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(observeOverviewQuery());
  const animate = !usePrefersReducedMotion();
  const data = query.data;
  // Rebuilt only when a tick brings new numbers, so the bars morph instead of re-entering.
  const trendNodes = useMemo(() => (data ? trends(data, animate) : null), [data, animate]);

  if (!data && !query.isError) {
    return (
      <section aria-busy="true" aria-label={t("live.label")}>
        <StatGroup aria-hidden="true" columns="live">
          {Array.from({ length: 6 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
            <StatTileSkeleton key={index} metrics={0} size="kpi" />
          ))}
        </StatGroup>
      </section>
    );
  }

  // Without data (load failed) the tiles keep their labels; the page banner shows the error.
  const shown: Partial<Record<TileId, string>> = data ? values(data, lang) : {};
  return (
    <section aria-label={t("live.label")} data-state={data ? undefined : "error"}>
      <StatGroup columns="live">
        {tiles(t).map((tile) => (
          <StatTile
            hint={tile.hint}
            icon={tile.icon}
            key={tile.id}
            label={tile.label}
            size="kpi"
            // Red marks the icon only while errors are happening; the value keeps its colour.
            tone={tile.id === "errRate" && data && data.errRate5 > 0 ? "danger" : "default"}
            trend={trendNodes?.[tile.id]}
            value={shown[tile.id] ?? EMPTY}
          />
        ))}
      </StatGroup>
    </section>
  );
}

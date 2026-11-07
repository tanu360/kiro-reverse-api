import {
  Activity01Icon,
  AlertCircleIcon,
  Coins01Icon,
  Download04Icon,
  Upload04Icon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode, useMemo } from "react";
import {
  StatGroup,
  StatTile,
  type StatTileProps,
  StatTileSkeleton,
} from "@/components/shared/stat-card";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { observeOverviewQuery } from "@/lib/api/observe";
import type { ObserveOverview, ObserveSeries } from "@/lib/api/types";
import { EMPTY, formatCredits, formatFraction, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { type Bars, rateBars, sumBars } from "./aggregate";
import { FAILED_COLOR } from "./colors";
import { LazySparkline } from "./lazy-sparkline";

// The tiles in order; while loading, each has a placeholder.
const TILE_IDS = ["rpm", "errRate", "inTpm", "outTpm", "credits60", "activeAccounts"] as const;
type TileId = (typeof TILE_IDS)[number];

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

/** Older servers send no series; every tile then shows a flat line. */
const NO_SERIES: ObserveSeries = { rpm: [], errRate: [], inTpm: [], outTpm: [], credits: [] };

function trends(o: ObserveOverview, animate: boolean): Record<TileId, ReactNode> {
  const series = o.series ?? NO_SERIES;
  const errRate = rateBars(series.rpm ?? [], series.errRate ?? []);
  const last = errRate.at(-1)?.value ?? 0;
  const before = errRate.at(-2)?.value ?? 0;
  const sparkline = (data: Bars, color?: string, idle = false) => (
    <LazySparkline animate={animate} color={color} data={data} idle={idle} />
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
    // The error area is red while the error rate is rising, otherwise the quiet grey.
    errRate: sparkline(errRate, FAILED_COLOR, last <= before),
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
          {TILE_IDS.map((id) => (
            <StatTileSkeleton key={id} metrics={0} size="kpi" />
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

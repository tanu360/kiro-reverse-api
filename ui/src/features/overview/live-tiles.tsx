import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { StatGroup, StatTile, StatTileSkeleton } from "@/components/shared/stat-card";
import { observeOverviewQuery } from "@/lib/api/observe";
import type { ObserveOverview } from "@/lib/api/types";
import { EMPTY, formatCredits, formatFraction, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";

interface Tile {
  id: string;
  label: string;
  hint?: string;
}

function tiles(t: TFunction): Tile[] {
  return [
    { id: "rpm", label: t("live.rpm") },
    { id: "errRate", label: t("live.errRate") },
    { id: "inTpm", label: t("live.inTpm") },
    { id: "outTpm", label: t("live.outTpm") },
    { id: "credits60", label: t("live.credits60") },
    { id: "activeAccounts", label: t("live.activeAccounts"), hint: t("live.activeAccountsHint") },
  ];
}

function values(o: ObserveOverview, lang: Lang): Record<string, string> {
  return {
    rpm: formatNumber(o.rpm1, lang),
    errRate: formatFraction(o.errRate5, 1, lang),
    inTpm: formatNumber(Math.round(o.inTpm5), lang),
    outTpm: formatNumber(Math.round(o.outTpm5), lang),
    credits60: formatCredits(o.credits60, 2, lang),
    activeAccounts: `${formatNumber(o.activeAccts, lang)} / ${formatNumber(o.totalAccts, lang)}`,
  };
}

/**
 * Six live tiles from /observe/overview, refreshed by SSE observe ticks: separate StatTile cards
 * with the KPI strip's anatomy (label row, 24 px value, the reserved trend row).
 */
export function LiveTiles(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(observeOverviewQuery());
  const data = query.data;

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
  const shown = data ? values(data, lang) : {};
  return (
    <section aria-label={t("live.label")} data-state={data ? undefined : "error"}>
      <StatGroup columns="live">
        {tiles(t).map((tile) => (
          // The delta row stays reserved (28 px) for the per-tile trends the server will send.
          <StatTile
            hint={tile.hint}
            key={tile.id}
            label={tile.label}
            size="kpi"
            value={shown[tile.id] ?? EMPTY}
          />
        ))}
      </StatGroup>
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import type { JSX } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { observeOverviewQuery } from "@/lib/api/observe";
import type { ObserveOverview } from "@/lib/api/types";
import { formatFraction, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";

const GRID_CLASS = "grid grid-cols-2 gap-4 @md/main:grid-cols-3 @5xl/main:grid-cols-6";
const TILE_CLASS = "min-w-0 gap-1.5 p-4 shadow-xs";

interface Tile {
  id: string;
  label: string;
  value: string;
  hint?: string;
}

function tiles(o: ObserveOverview, t: TFunction, lang: Lang): Tile[] {
  return [
    { id: "rpm", label: t("live.rpm"), value: formatNumber(o.rpm1, lang) },
    { id: "errRate", label: t("live.errRate"), value: formatFraction(o.errRate5) },
    { id: "inTpm", label: t("live.inTpm"), value: formatNumber(Math.round(o.inTpm5), lang) },
    { id: "outTpm", label: t("live.outTpm"), value: formatNumber(Math.round(o.outTpm5), lang) },
    { id: "credits60", label: t("live.credits60"), value: o.credits60.toFixed(2) },
    {
      id: "activeAccounts",
      label: t("live.activeAccounts"),
      value: `${formatNumber(o.activeAccts, lang)} / ${formatNumber(o.totalAccts, lang)}`,
      hint: t("live.activeAccountsHint"),
    },
  ];
}

function TileLabel({ tile }: { tile: Tile }): JSX.Element {
  if (!tile.hint) {
    return <dt className="truncate text-muted-foreground text-sm">{tile.label}</dt>;
  }
  return (
    <dt className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="inline-flex max-w-full items-center gap-1 rounded-sm text-left text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            />
          }
        >
          <span className="truncate">{tile.label}</span>
          <InfoIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        </TooltipTrigger>
        <TooltipPopup className="max-w-72">{tile.hint}</TooltipPopup>
      </Tooltip>
    </dt>
  );
}

/** Six live tiles from /observe/overview, refreshed by SSE observe ticks. */
export function LiveTiles(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(observeOverviewQuery());
  const data = query.data;

  if (!data) {
    if (query.isError) {
      return (
        <Card aria-label={t("live.label")} render={<section />}>
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      );
    }
    return (
      <section aria-busy="true" aria-label={t("live.label")} className={GRID_CLASS}>
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <Card aria-hidden="true" className={TILE_CLASS} key={index}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-7 w-1/2" />
          </Card>
        ))}
      </section>
    );
  }

  return (
    <section aria-label={t("live.label")} className="flex flex-col gap-4">
      {query.isError ? (
        <Card>
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : null}
      <dl className={GRID_CLASS}>
        {tiles(data, t, lang).map((tile) => (
          <Card className={TILE_CLASS} data-slot="live-tile" data-tile={tile.id} key={tile.id}>
            <TileLabel tile={tile} />
            <dd className="truncate font-medium text-2xl leading-tight tracking-tight tabular-nums">
              {tile.value}
            </dd>
          </Card>
        ))}
      </dl>
    </section>
  );
}

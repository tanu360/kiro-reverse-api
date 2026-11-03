import { useQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import type { JSX } from "react";
import { Card } from "@/components/ui/card";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { observeOverviewQuery } from "@/lib/api/observe";
import type { ObserveOverview } from "@/lib/api/types";
import { EMPTY, formatFraction, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";

// Columns follow the page's content width (@container/main), not the viewport, so labels such
// as "Output tokens/min" fit: three tiles per row from 36rem, six from 64rem.
const GRID_CLASS = "grid grid-cols-2 gap-4 @xl/main:grid-cols-3 @5xl/main:grid-cols-6";
const TILE_CLASS = "min-w-0 gap-1.5 p-4 shadow-xs";

interface Tile {
  id: string;
  label: string;
  value: string;
  hint?: string;
}

function labels(t: TFunction): Omit<Tile, "value">[] {
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
    errRate: formatFraction(o.errRate5),
    inTpm: formatNumber(Math.round(o.inTpm5), lang),
    outTpm: formatNumber(Math.round(o.outTpm5), lang),
    credits60: o.credits60.toFixed(2),
    activeAccounts: `${formatNumber(o.activeAccts, lang)} / ${formatNumber(o.totalAccts, lang)}`,
  };
}

/**
 * A label with an explanation. A popover rather than a tooltip, so a tap opens it on touch
 * screens; hover still opens it with a mouse. The trigger's hit area grows to 44 px on coarse
 * pointers without changing the layout.
 */
function HintLabel({ label, hint }: { label: string; hint: string }): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        className="relative inline-flex max-w-full items-center gap-1 rounded-sm text-left text-muted-foreground text-sm outline-none after:absolute after:top-1/2 after:left-1/2 after:size-full after:-translate-x-1/2 after:-translate-y-1/2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
        data-slot="hint-trigger"
        delay={200}
        openOnHover
      >
        <span className="truncate">{label}</span>
        <InfoIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </PopoverTrigger>
      <PopoverPopup className="max-w-72" side="top" tooltipStyle>
        {hint}
      </PopoverPopup>
    </Popover>
  );
}

function TileLabel({ tile }: { tile: Omit<Tile, "value"> }): JSX.Element {
  if (!tile.hint) {
    return <dt className="truncate text-muted-foreground text-sm">{tile.label}</dt>;
  }
  return (
    <dt className="min-w-0">
      <HintLabel hint={tile.hint} label={tile.label} />
    </dt>
  );
}

/** Six live tiles from /observe/overview, refreshed by SSE observe ticks. */
export function LiveTiles(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(observeOverviewQuery());
  const data = query.data;

  if (!data && !query.isError) {
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

  // Without data (load failed) the tiles keep their labels; the page banner shows the error.
  const shown = data ? values(data, lang) : {};
  return (
    <section aria-label={t("live.label")} data-state={data ? undefined : "error"}>
      <dl className={GRID_CLASS}>
        {labels(t).map((tile) => (
          <Card className={TILE_CLASS} data-slot="live-tile" data-tile={tile.id} key={tile.id}>
            <TileLabel tile={tile} />
            <dd className="truncate font-medium text-2xl leading-tight tracking-tight tabular-nums">
              {shown[tile.id] ?? EMPTY}
            </dd>
          </Card>
        ))}
      </dl>
    </section>
  );
}

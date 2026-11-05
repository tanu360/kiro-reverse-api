import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cva } from "class-variance-authority";
import { type ComponentProps, createContext, type JSX, type ReactNode, useContext } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { InfoHint } from "./info-hint";

export interface StatMetric {
  label: string;
  value: ReactNode;
  tone?: "default" | "danger" | "muted";
  wide?: boolean;
  /**
   * Lets a long value wrap at its spaces instead of being cut off with an ellipsis: "a / b"
   * breaks after the slash in a narrow card.
   */
  wrap?: boolean;
  /** Explains the label in a popup that opens on hover, click or tap (info icon on the label). */
  hint?: string;
}

export interface StatDelta {
  /** A fraction: 0.12 = +12 %. */
  value: number;
  /** The comparison, in the muted colour after the value ("vs previous hour"). */
  label: string;
  /** Which direction is good news (green); the other is red. Default up. */
  goodWhen?: "up" | "down";
}

export interface StatTileProps {
  icon?: IconSvgElement;
  label: string;
  /** Explains the label in a popup (info icon after it). */
  hint?: ReactNode;
  value: ReactNode;
  /** `display` (28 px) for the KPI strip, `kpi` (24 px) for the smaller live tiles. */
  size?: "display" | "kpi";
  /** `danger` colours the icon (and nothing else: the value keeps the text colour). */
  tone?: "default" | "danger";
  delta?: StatDelta | null;
  /** A muted line in the delta row, after the delta or in its place ("94 % capacity used"). */
  caption?: ReactNode;
  /**
   * The trend slot at the end of the delta row, 28 px tall and always reserved: a BarSparkline,
   * a Meter, or nothing. Decorative; wrapped in aria-hidden.
   */
  trend?: ReactNode;
  /** @deprecated Use `trend`. */
  sparkline?: ReactNode;
  metrics?: StatMetric[];
  loading?: boolean;
  /** Layout classes only. */
  className?: string;
}

/** @deprecated Use StatTileProps. */
export type StatCardProps = StatTileProps;

/** 0.125 -> "+12.5%", -0.2 -> "-20%", 0 -> "0%" (in the UI language's number format). */
export function formatDelta(fraction: number, lang?: Lang): string {
  const rounded = Math.round(fraction * 1000) / 1000;
  return numberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(rounded);
}

/*
 * Where a tile sits decides its chrome:
 * - joined: a cell of one StatGroup card (opaque card fill; the group's 1 px gaps draw the
 *   dividers), whose four rows line up with its neighbours' through a subgrid;
 * - separate: its own card in a StatGroup grid with 16 px gaps;
 * - standalone (no StatGroup): its own card.
 */
type Placement = "joined" | "separate" | "standalone";
const PlacementContext = createContext<Placement>("standalone");

const tileVariants = cva("min-w-0 p-4 sm:p-5", {
  variants: {
    placement: {
      joined: "row-span-4 grid grid-rows-subgrid gap-y-0 bg-card",
      separate: "flex flex-col rounded-xl border border-border bg-card",
      standalone: "flex flex-1 flex-col",
    },
  },
});

const groupVariants = cva("grid min-w-0", {
  variants: {
    columns: {
      // One column on phones, two from 28rem of content, four from 64rem.
      kpi: "grid-cols-1 @md/main:grid-cols-2 @5xl/main:grid-cols-4",
      // Two, then three from 36rem, then six from 64rem.
      live: "grid-cols-2 @xl/main:grid-cols-3 @5xl/main:grid-cols-6",
    },
    joined: {
      // Opaque tiles over a hairline-coloured grid: the 1 px gaps are the dividers.
      true: "gap-px bg-border-subtle",
      false: "gap-4",
    },
  },
});

/**
 * A row of stat tiles. `joined` draws them as one card split by hairlines (the KPI strip);
 * otherwise each tile is its own card, 16 px apart. By default the KPI columns are joined and
 * the live columns are separate.
 */
export function StatGroup({
  columns = "kpi",
  joined = columns === "kpi",
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  columns?: "kpi" | "live";
  joined?: boolean;
}): JSX.Element {
  const grid = (
    <div
      className={cn(groupVariants({ columns, joined }), !joined && className)}
      data-columns={columns}
      data-joined={joined ? "" : undefined}
      data-slot="stat-group"
      {...(joined ? {} : props)}
    >
      <PlacementContext.Provider value={joined ? "joined" : "separate"}>
        {children}
      </PlacementContext.Provider>
    </div>
  );
  if (!joined) return grid;
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground",
        className,
      )}
      data-slot="stat-group-card"
      {...props}
    >
      {grid}
    </div>
  );
}

function TileShell({
  className,
  children,
  slot,
  tone,
}: {
  className?: string;
  children: ReactNode;
  slot: string;
  tone?: string;
}): JSX.Element {
  const placement = useContext(PlacementContext);
  const tile = (
    <div
      className={cn(tileVariants({ placement }), placement !== "standalone" && className)}
      data-slot={slot}
      data-tone={tone}
    >
      {children}
    </div>
  );
  if (placement !== "standalone") return tile;
  return (
    <Card className={cn("min-w-0", className)} data-slot="stat-card">
      {tile}
    </Card>
  );
}

function DeltaText({ delta, lang }: { delta: StatDelta; lang: Lang }): JSX.Element {
  const direction = delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat";
  const goodWhen = delta.goodWhen ?? "up";
  const tone = direction === "flat" ? "neutral" : direction === goodWhen ? "good" : "bad";
  return (
    <span className="min-w-0" data-slot="stat-delta" data-tone={tone}>
      <span
        className={cn(
          "font-medium tabular-nums",
          tone === "good" && "text-success-foreground",
          tone === "bad" && "text-destructive-foreground",
          tone === "neutral" && "text-foreground",
        )}
      >
        {formatDelta(delta.value, lang)}
      </span>{" "}
      <span className="text-muted-foreground">{delta.label}</span>
    </span>
  );
}

function MetricLabel({ metric }: { metric: StatMetric }): JSX.Element {
  if (!metric.hint) {
    return <dt className="line-clamp-2 text-pretty text-muted-foreground">{metric.label}</dt>;
  }
  return (
    <dt className="min-w-0">
      <InfoHint hint={metric.hint}>{metric.label}</InfoHint>
    </dt>
  );
}

const VALUE_SIZE = { display: "text-display", kpi: "text-kpi" } as const;
/*
 * The metrics grid under its hairline. In a joined group the rows share subgrid tracks, so the
 * hairlines line up at the top of the metrics row; in a lone card it sinks to the bottom.
 */
const METRICS_CLASS = "grid grid-cols-2 gap-3 border-border-subtle border-t pt-3";

/**
 * One stat: the label row (icon and label), the value, the delta row (signed change in green or
 * red, a muted comparison, and the 28 px trend slot at the end) and an optional metrics grid
 * under a hairline. Rows keep their heights when empty, so tiles side by side line up.
 */
export function StatTile({
  icon,
  label,
  hint,
  value,
  size = "display",
  tone = "default",
  delta,
  caption,
  trend,
  sparkline,
  metrics,
  loading = false,
  className,
}: StatTileProps): JSX.Element {
  const { lang } = useT();
  const placement = useContext(PlacementContext);
  if (loading) {
    return <StatTileSkeleton className={className} metrics={metrics?.length ?? 0} size={size} />;
  }

  const trendSlot = trend ?? sparkline;
  const hasMetrics = metrics !== undefined && metrics.length > 0;
  return (
    <TileShell className={className} slot="stat-tile" tone={tone}>
      <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        {icon ? (
          <HugeiconsIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0", tone === "danger" && "text-destructive-foreground")}
            icon={icon}
          />
        ) : null}
        {hint ? (
          // One line like the plain labels, so every tile's label row stays 20 px and the values
          // beside it line up.
          <InfoHint hint={hint} truncate>
            {label}
          </InfoHint>
        ) : (
          <p className="min-w-0 truncate">{label}</p>
        )}
      </div>
      <div
        className={cn(
          "mt-3 min-w-0 break-words font-semibold text-foreground leading-none tabular-nums",
          VALUE_SIZE[size],
        )}
        data-slot="stat-value"
      >
        {value}
      </div>
      <div
        className={cn(
          "mt-2 flex min-h-7 min-w-0 items-end justify-between gap-3 text-meta",
          hasMetrics && "mb-4",
        )}
      >
        {/* The delta keeps its line; the trend gives way first, down to 48 px. */}
        <div
          className={cn(
            "flex min-w-0 flex-col gap-0.5",
            trendSlot && "max-w-[calc(100%-3.75rem)] shrink-0",
          )}
        >
          {delta ? <DeltaText delta={delta} lang={lang} /> : null}
          {caption ? <span className="min-w-0 text-muted-foreground">{caption}</span> : null}
        </div>
        {trendSlot ? (
          <div aria-hidden="true" className="h-7 w-24 min-w-12 shrink" data-slot="stat-trend">
            {trendSlot}
          </div>
        ) : null}
      </div>
      {metrics && hasMetrics ? (
        <dl className={cn(METRICS_CLASS, "text-xs", placement !== "joined" && "mt-auto")}>
          {metrics.map((metric) => (
            <div
              className={cn("flex min-w-0 flex-col gap-0.5", metric.wide && "col-span-2")}
              key={metric.label}
            >
              <MetricLabel metric={metric} />
              <dd
                className={cn(
                  "font-medium text-sm tabular-nums",
                  metric.wrap ? "break-words" : "truncate",
                  metric.tone === "danger" && "text-destructive-foreground",
                  metric.tone === "muted" && "text-muted-foreground",
                )}
              >
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </TileShell>
  );
}

/**
 * The tile's placeholder, row for row: label, value, delta with the trend block, and (with
 * `metrics`) the hairline and a 2x2 grid, so nothing shifts when the data arrives.
 */
export function StatTileSkeleton({
  metrics = 4,
  size = "display",
  className,
}: {
  /** How many metric cells to reserve (rounded up to full rows of two); 0 for none. */
  metrics?: number;
  size?: "display" | "kpi";
  className?: string;
}): JSX.Element {
  const cells = Math.ceil(Math.max(0, metrics) / 2) * 2;
  const placement = useContext(PlacementContext);
  return (
    <TileShell className={className} slot="stat-card-skeleton">
      <div aria-hidden="true" className="flex min-h-5 items-center">
        <Skeleton className="h-4 w-1/3" />
      </div>
      <Skeleton aria-hidden="true" className={cn("mt-3 w-1/2", size === "kpi" ? "h-6" : "h-7")} />
      <div
        aria-hidden="true"
        className={cn("mt-2 flex min-h-7 items-end justify-between gap-3", cells > 0 && "mb-4")}
      >
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-7 w-24 min-w-12 shrink" />
      </div>
      {cells > 0 ? (
        <div aria-hidden="true" className={cn(METRICS_CLASS, placement !== "joined" && "mt-auto")}>
          {Array.from({ length: cells }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells never reorder.
            <div className="flex flex-col gap-0.5" key={index}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ))}
        </div>
      ) : null}
    </TileShell>
  );
}

/** @deprecated A standalone StatTile in its own card; use StatTile (inside a StatGroup). */
export const StatCard = StatTile;

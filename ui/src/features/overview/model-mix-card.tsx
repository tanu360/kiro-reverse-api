import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { ShareBar } from "@/components/charts/share-bar";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard } from "@/components/shared/list-card";
import { TableSkeleton } from "@/components/shared/loading-state";
import { SectionCard } from "@/components/shared/section-card";
import { TokenCell } from "@/components/shared/token-cell";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Skeleton } from "@/components/ui/skeleton";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { modelMixQuery } from "@/lib/api/observe";
import type { ModelMixEntry } from "@/lib/api/types";
import { formatCompact, formatCredits, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type MixSource, modelSlices } from "./aggregate";
import { MODEL_COLORS, OTHER_MODEL_COLOR } from "./colors";
import type { RingSlice } from "./model-mix-donut";
import { useTotalsFailed } from "./totals";

const ModelMixDonut = lazy(() => import("./model-mix-donut"));

/** Five models in the donut (plus "Other") and five rows in the table: the same five. */
const RING_MODELS = MODEL_COLORS.length;
/** The mix card's footer, the header's height with the "N more" count at its end. */
export const MIX_FOOTER = "min-h-12 justify-end sm:min-h-14";

/** Rows the mix table shows; the card's footer counts the rest. */
export const MIX_TABLE_ROWS = RING_MODELS;

/**
 * One row of the mix: a model on the Overview; a model or an account of one API key in its usage
 * cards.
 */
export interface MixItem extends MixSource {
  /** The row's handle: unique, unlike two accounts' masked emails. */
  id: string;
  /** In, out and cached tokens; only the total where the split is not known. */
  tokens:
    | Pick<ModelMixEntry, "inTokens" | "outTokens" | "cacheReadTokens" | "cacheWriteTokens">
    | number;
}

interface MixRow {
  item: MixItem;
  color: string;
  /** This row's part of the total (credits, or requests), 0..1. */
  share: number;
}

function ColorDot({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/** Renders a row's name after its colour dot; the plain name by default. */
type MixNameRenderer = (item: MixItem) => ReactNode;

function ModelName({
  row,
  renderName,
}: {
  row: MixRow;
  renderName?: MixNameRenderer;
}): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ColorDot color={row.color} />
      {renderName ? renderName(row.item) : <TruncatedText>{row.item.model}</TruncatedText>}
    </span>
  );
}

function Tokens({ tokens }: { tokens: MixItem["tokens"] }): JSX.Element {
  const { lang } = useT();
  if (typeof tokens === "number") {
    return <span className="tabular-nums">{formatCompact(tokens, lang)}</span>;
  }
  return (
    <TokenCell
      cacheReadTokens={tokens.cacheReadTokens}
      cacheWriteTokens={tokens.cacheWriteTokens}
      inTokens={tokens.inTokens}
      outTokens={tokens.outTokens}
    />
  );
}

/** Card widths from which the ring sits beside the table: 32rem or 36rem. */
type MixBreakpoint = "lg" | "xl";

/**
 * The layout classes for each breakpoint, written out whole so Tailwind finds them. The Overview's
 * half-width card takes 32rem; the API key usage sheet, whose card is only just wider, 36rem, so
 * there the ring stacks over a full-width table instead of squeezing it.
 */
const BESIDE: Record<MixBreakpoint, { row: string; ring: string; table: string }> = {
  lg: {
    row: "@lg:flex-row @lg:items-center",
    ring: "@lg:max-w-56",
    table: "@lg:self-stretch @lg:border-s @lg:border-t-0",
  },
  xl: {
    row: "@xl:flex-row @xl:items-center",
    ring: "@xl:max-w-56",
    table: "@xl:self-stretch @xl:border-s @xl:border-t-0",
  },
};

/**
 * The ring and rows when `rest` is itself a rest: the five busiest others first, then `rest` in
 * grey, as its own row and slice while the table has room for it, else inside the ring's
 * "Other" with everything past the five.
 */
function mixWithRest(
  items: readonly MixItem[],
  rest: MixItem,
  metricOf: (item: MixItem) => number,
  total: number,
  otherLabel: string,
): { ring: RingSlice[]; rows: MixRow[] } {
  const named = items.filter((item) => item !== rest).sort((a, b) => metricOf(b) - metricOf(a));
  const others = named.slice(RING_MODELS);
  const share = (item: MixItem) => (total > 0 ? metricOf(item) / total : 0);
  const rows: MixRow[] = named
    .slice(0, RING_MODELS)
    .map((item, index) => ({ item, color: MODEL_COLORS[index], share: share(item) }));
  if (others.length === 0) {
    rows.push({ item: rest, color: OTHER_MODEL_COLOR, share: share(rest) });
  }
  const ring: RingSlice[] = rows.map((row) => ({
    label: row.item.model,
    value: metricOf(row.item),
    maxValue: total,
    color: row.color,
  }));
  if (others.length > 0) {
    ring.push({
      label: otherLabel,
      value: others.reduce((sum, item) => sum + metricOf(item), metricOf(rest)),
      maxValue: total,
      color: OTHER_MODEL_COLOR,
    });
  }
  return { ring, rows };
}

/** The mix while it loads: the ring and the table as placeholders. Put it in a padded panel. */
export function ModelMixSkeleton({
  besideFrom = "lg",
}: {
  besideFrom?: MixBreakpoint;
} = {}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn("flex flex-1 flex-col items-center gap-4", BESIDE[besideFrom].row)}
    >
      <Skeleton className="aspect-square w-full max-w-56 shrink-0 rounded-full" />
      <TableSkeleton columns={4} rows={MIX_TABLE_ROWS} />
    </div>
  );
}

/**
 * The mix itself, for a slim card: a donut of the top five and "Other" beside a ranked table of
 * the top five (name, requests, tokens, credits). Hovering a table row lifts its slice, and
 * hovering a slice dims the other rows. `items` is not empty.
 */
export function ModelMixPanel({
  items,
  by,
  caption,
  chartLabel,
  nameHeader,
  renderName,
  restId,
  besideFrom = "lg",
}: {
  items: readonly MixItem[];
  /** The measure: credits, or requests while nothing used credits (the Overview's rule). */
  by?: "credits" | "reqs";
  /** The table's name; the cards list on a phone takes it too. */
  caption: string;
  /** Names the donut; "Share of credits (or requests) by model" by default. */
  chartLabel?: string;
  /** The first column's header: "Model" by default. */
  nameHeader?: string;
  /** Each row's name after its dot (a caller's mark and name); the plain `model` by default. */
  renderName?: MixNameRenderer;
  /**
   * The item that is itself a rest (a key's requests from no known client): it ranks after every
   * other, in grey, and joins the ring's "Other" slice when there is one, so the ring never
   * shows two "Other" slices.
   */
  restId?: string;
  /** The card width from which the ring sits beside the table: 32rem by default. */
  besideFrom?: MixBreakpoint;
}): JSX.Element {
  const { t, lang } = useT("overview");
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState<number | null>(null);
  const otherLabel = t("modelMix.other");

  const mix = useMemo(() => {
    const { slices, metric, total } = modelSlices(items, RING_MODELS, otherLabel, by);
    const metricOf = (item: MixItem) => (metric === "credits" ? item.credits : item.reqs);
    const rest = restId === undefined ? undefined : items.find((item) => item.id === restId);
    if (rest) return { ...mixWithRest(items, rest, metricOf, total, otherLabel), metric };
    const ring: RingSlice[] = slices.map((slice, index) => ({
      ...slice,
      color: index < RING_MODELS ? MODEL_COLORS[index] : OTHER_MODEL_COLOR,
    }));
    const sorted = [...items].sort((a, b) => metricOf(b) - metricOf(a));
    const rows: MixRow[] = sorted.slice(0, MIX_TABLE_ROWS).map((item, index) => ({
      item,
      color: MODEL_COLORS[index] ?? OTHER_MODEL_COLOR,
      share: total > 0 ? metricOf(item) / total : 0,
    }));
    return { ring, metric, rows };
  }, [items, otherLabel, by, restId]);

  const columns = useMemo<DataTableColumn<MixRow>[]>(() => {
    // While a slice or row is hovered, every cell of the other rows dims.
    const focus = (index: number, className: string | undefined, children: ReactNode) => (
      <div
        className={cn(
          "transition-opacity",
          hovered !== null && hovered !== index && "opacity-50",
          className,
        )}
      >
        {children}
      </div>
    );
    return [
      {
        id: "model",
        header: nameHeader ?? t("modelMix.model"),
        cell: (row, index) =>
          focus(
            index,
            "flex min-w-0 flex-col gap-1.5",
            <>
              <ModelName renderName={renderName} row={row} />
              <ShareBar className="max-w-40" color={row.color} value={row.share} />
            </>,
          ),
        // The name takes whatever the figures leave (w-full), and max-w-0 lets it give way: a
        // long model ID truncates instead of widening the table past its card.
        className: "w-full max-w-0",
      },
      {
        id: "reqs",
        header: t("modelMix.requests"),
        align: "end",
        // w-px + nowrap: the figure columns shrink to their content and leave the rest to the name.
        className: "w-px whitespace-nowrap",
        cell: (row, index) =>
          focus(index, "text-muted-foreground", formatNumber(row.item.reqs, lang)),
      },
      {
        id: "tokens",
        header: t("modelMix.tokens"),
        // The narrowest tables (a phone, the half-width card) keep model, requests and credits.
        //! From 28rem the four columns overflowed by up to 50 px beside the ring (the key holder's
        //! page, which has no sidebar, at 1280-1440 px): tokens join at 32rem.
        className: "hidden w-px whitespace-nowrap @lg/data-table:table-cell",
        headerClassName: "hidden @lg/data-table:table-cell",
        cell: (row, index) => focus(index, undefined, <Tokens tokens={row.item.tokens} />),
      },
      {
        id: "credits",
        header: t("modelMix.credits"),
        align: "end",
        className: "w-px whitespace-nowrap",
        cell: (row, index) => focus(index, "font-medium", formatCredits(row.item.credits)),
      },
    ];
  }, [t, lang, hovered, nameHeader, renderName]);

  const renderCard = (row: MixRow) => (
    <ListCard title={<ModelName renderName={renderName} row={row} />} variant="row">
      <ShareBar className="max-w-40" color={row.color} value={row.share} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-meta">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.requests")}</dt>
          <dd className="tabular-nums">{formatNumber(row.item.reqs, lang)}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.credits")}</dt>
          <dd className="tabular-nums">{formatCredits(row.item.credits)}</dd>
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.tokens")}</dt>
          <dd className="min-w-0">
            <Tokens tokens={row.item.tokens} />
          </dd>
        </div>
      </dl>
    </ListCard>
  );

  const credits = mix.metric === "credits";
  return (
    // Ring beside the table once the card fits both (32rem, the half-width column of the
    // dashboard); stacked on a phone.
    // flex-1: beside a taller card (the traffic chart) the ring and table take the extra height,
    // so the footer stays one line at the bottom instead of growing.
    <div className={cn("flex min-w-0 flex-1 flex-col", BESIDE[besideFrom].row)}>
      <figure
        aria-label={
          chartLabel ?? t(credits ? "modelMix.chartLabel" : "modelMix.chartLabelRequests")
        }
        className={cn(
          "w-full max-w-64 shrink-0 self-center px-4 py-4 sm:px-6",
          BESIDE[besideFrom].ring,
        )}
      >
        <Suspense
          fallback={<Skeleton className="mx-auto aspect-square w-full max-w-56 rounded-full" />}
        >
          <ModelMixDonut
            centerLabel={t(credits ? "modelMix.centerCredits" : "modelMix.centerRequests")}
            fractionDigits={credits ? 2 : 0}
            hoveredIndex={hovered}
            onHoverChange={setHovered}
            reducedMotion={reducedMotion}
            shareLabel={t("modelMix.share")}
            slices={mix.ring}
          />
        </Suspense>
      </figure>
      {/*
        Hover only mirrors the ring; the rows carry the data. A hairline parts the table from
        the ring: down the card's full height beside it, across the card when stacked.
      */}
      <div className={cn("min-w-0 flex-1 border-border-subtle border-t", BESIDE[besideFrom].table)}>
        <DataTable
          caption={caption}
          cardLayout="divided"
          cardsBelow="xs"
          columns={columns}
          data={mix.rows}
          density="comfortable"
          getRowId={(row) => row.item.id}
          inset
          onRowHover={(row) => setHovered(row ? mix.rows.indexOf(row) : null)}
          renderCard={renderCard}
        />
      </div>
    </div>
  );
}

/** A model's row in the mix: the Overview counts tokens in, out and cached. */
function mixItem(entry: ModelMixEntry): MixItem {
  return {
    id: entry.model,
    model: entry.model,
    reqs: entry.reqs,
    credits: entry.credits,
    tokens: entry,
  };
}

/**
 * Donut of the top models by credits beside a ranked table, cumulative since start or the last
 * reset. Hovering a table row lifts its slice, and hovering a slice dims the other rows.
 */
export function ModelMixCard(): JSX.Element {
  const { t } = useT("overview");
  const query = useQuery(modelMixQuery());
  const totalsFailed = useTotalsFailed();
  const models = query.data;
  const items = useMemo(() => models?.map(mixItem), [models]);
  const rest = Math.max(0, (models?.length ?? 0) - MIX_TABLE_ROWS);

  let body: JSX.Element;
  let slim = false;
  if (!items) {
    if (query.isError) {
      body = totalsFailed ? (
        <ErrorState notLoaded />
      ) : (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("errors.modelMix")}
        />
      );
    } else {
      body = <ModelMixSkeleton />;
    }
  } else if (items.length === 0) {
    body = (
      <EmptyState
        description={t("traffic.noTrafficBody")}
        icon={AiBrain01Icon}
        title={t("modelMix.empty")}
        variant="compact"
      />
    );
  } else {
    // The table runs edge to edge (slim card, inset cells); the ring keeps the panel padding.
    slim = true;
    body = (
      <>
        {query.isError && !totalsFailed ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
            title={t("errors.modelMix")}
          />
        ) : null}
        <ModelMixPanel caption={t("modelMix.title")} items={items} />
      </>
    );
  }

  return (
    <SectionCard
      description={t("modelMix.description")}
      descriptionVariant="inline"
      footer={rest > 0 ? <p>{t("modelMix.moreModels", { count: rest })}</p> : undefined}
      // As tall as the header (48 / 56 px), the count at the end, centred on that height.
      footerClassName={MIX_FOOTER}
      icon={AiBrain01Icon}
      id="overview-model-mix"
      slim={slim}
      title={t("modelMix.title")}
    >
      {body}
    </SectionCard>
  );
}

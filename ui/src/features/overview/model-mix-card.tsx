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
import { Skeleton } from "@/components/ui/skeleton";
import { modelMixQuery } from "@/lib/api/observe";
import type { ModelMixEntry } from "@/lib/api/types";
import { formatCredits, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { modelSlices } from "./aggregate";
import { MODEL_COLORS, OTHER_MODEL_COLOR } from "./colors";
import type { RingSlice } from "./model-mix-ring";
import { useTotalsFailed } from "./status-cards";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const ModelMixRing = lazy(() => import("./model-mix-ring"));

/** Five models on the ring (plus "Other") and five rows in the table: the same five. */
const RING_MODELS = MODEL_COLORS.length;
const TABLE_ROWS = RING_MODELS;

interface MixRow {
  entry: ModelMixEntry;
  color: string;
  /** This model's part of the total (credits, or requests before any credits), 0..1. */
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

function ModelName({ row }: { row: MixRow }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ColorDot color={row.color} />
      <span className="min-w-0 truncate">{row.entry.model}</span>
    </span>
  );
}

/**
 * Ring of the top models by credits beside a ranked table, cumulative since start or the last
 * reset. Hovering a table row lights its ring, and hovering a ring dims the other rows.
 */
export function ModelMixCard(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(modelMixQuery());
  const reducedMotion = usePrefersReducedMotion();
  const totalsFailed = useTotalsFailed();
  const [hovered, setHovered] = useState<number | null>(null);
  const models = query.data;
  const otherLabel = t("modelMix.other");

  const mix = useMemo(() => {
    if (!models) return null;
    const { slices, metric, total } = modelSlices(models, RING_MODELS, otherLabel);
    const ring: RingSlice[] = slices.map((slice, index) => ({
      ...slice,
      color: index < RING_MODELS ? MODEL_COLORS[index] : OTHER_MODEL_COLOR,
    }));
    const metricOf = (m: ModelMixEntry) => (metric === "credits" ? m.credits : m.reqs);
    const sorted = [...models].sort((a, b) => metricOf(b) - metricOf(a));
    const rows: MixRow[] = sorted.slice(0, TABLE_ROWS).map((entry, index) => ({
      entry,
      color: MODEL_COLORS[index] ?? OTHER_MODEL_COLOR,
      share: total > 0 ? metricOf(entry) / total : 0,
    }));
    return { ring, metric, rows, rest: Math.max(0, sorted.length - TABLE_ROWS) };
  }, [models, otherLabel]);

  const columns = useMemo<DataTableColumn<MixRow>[]>(() => {
    // While a ring or row is hovered, every cell of the other rows dims, as the ring does.
    const focus = (index: number, className: string | undefined, children: ReactNode) => (
      <div
        className={cn(
          "transition-opacity motion-reduce:transition-none",
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
        header: t("modelMix.model"),
        cell: (row, index) =>
          focus(
            index,
            "flex min-w-0 flex-col gap-1.5",
            <>
              <ModelName row={row} />
              <ShareBar className="max-w-40" color={row.color} value={row.share} />
            </>,
          ),
        className: "w-2/5 max-w-64",
      },
      {
        id: "reqs",
        header: t("modelMix.requests"),
        align: "end",
        cell: (row, index) =>
          focus(index, "text-muted-foreground", formatNumber(row.entry.reqs, lang)),
      },
      {
        id: "tokens",
        header: t("modelMix.tokens"),
        cell: (row, index) =>
          focus(
            index,
            undefined,
            <TokenCell
              cacheReadTokens={row.entry.cacheReadTokens}
              cacheWriteTokens={row.entry.cacheWriteTokens}
              detailClassName="min-w-48"
              inTokens={row.entry.inTokens}
              outTokens={row.entry.outTokens}
            />,
          ),
      },
      {
        id: "credits",
        header: t("modelMix.credits"),
        align: "end",
        cell: (row, index) => focus(index, "font-medium", formatCredits(row.entry.credits)),
      },
    ];
  }, [t, lang, hovered]);

  const renderCard = (row: MixRow) => (
    <ListCard title={<ModelName row={row} />} variant="row">
      <ShareBar className="max-w-40" color={row.color} value={row.share} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-meta">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.requests")}</dt>
          <dd className="tabular-nums">{formatNumber(row.entry.reqs, lang)}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.credits")}</dt>
          <dd className="tabular-nums">{formatCredits(row.entry.credits)}</dd>
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground">{t("modelMix.tokens")}</dt>
          <dd className="min-w-0">
            <TokenCell
              cacheReadTokens={row.entry.cacheReadTokens}
              cacheWriteTokens={row.entry.cacheWriteTokens}
              inTokens={row.entry.inTokens}
              outTokens={row.entry.outTokens}
            />
          </dd>
        </div>
      </dl>
    </ListCard>
  );

  let body: JSX.Element;
  let slim = false;
  if (!models || !mix) {
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
      body = (
        <div aria-hidden="true" className="flex flex-col items-center gap-4 @4xl:flex-row">
          <Skeleton className="aspect-square w-full max-w-56 shrink-0 rounded-full" />
          <TableSkeleton columns={4} rows={TABLE_ROWS} />
        </div>
      );
    }
  } else if (models.length === 0) {
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
    const credits = mix.metric === "credits";
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
        {/* Ring beside the table only when the card fits both (56rem); otherwise stacked. */}
        <div className="flex min-w-0 flex-col @4xl:flex-row @4xl:items-center">
          <figure
            aria-label={t(credits ? "modelMix.chartLabel" : "modelMix.chartLabelRequests")}
            className="w-full max-w-64 shrink-0 self-center px-4 py-4 sm:px-5"
          >
            <Suspense
              fallback={<Skeleton className="mx-auto aspect-square w-full max-w-56 rounded-full" />}
            >
              <ModelMixRing
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
          {/* Hover only mirrors the ring; the rows carry the data. */}
          <div className="min-w-0 flex-1">
            <DataTable
              caption={t("modelMix.title")}
              cardLayout="divided"
              cardsBelow="lg"
              columns={columns}
              data={mix.rows}
              density="comfortable"
              getRowId={(row) => row.entry.model}
              inset
              onRowHover={(row) => setHovered(row ? mix.rows.indexOf(row) : null)}
              renderCard={renderCard}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <SectionCard
      description={t("modelMix.description")}
      descriptionVariant="inline"
      footer={
        mix && mix.rest > 0 ? <p>{t("modelMix.moreModels", { count: mix.rest })}</p> : undefined
      }
      icon={AiBrain01Icon}
      id="overview-model-mix"
      slim={slim}
      title={t("modelMix.title")}
    >
      {body}
    </SectionCard>
  );
}

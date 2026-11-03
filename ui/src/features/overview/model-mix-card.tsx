import { useQuery } from "@tanstack/react-query";
import { BoxesIcon } from "lucide-react";
import { type JSX, lazy, Suspense, useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/loading-state";
import { SectionCard } from "@/components/shared/section-card";
import { TokenCell } from "@/components/shared/token-cell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { modelMixQuery } from "@/lib/api/observe";
import type { ModelMixEntry } from "@/lib/api/types";
import { formatCredits, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { modelSlices } from "./aggregate";
import { MODEL_COLORS, OTHER_MODEL_COLOR } from "./colors";
import type { RingSlice } from "./model-mix-ring";
import { ResponsiveList } from "./responsive-list";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const ModelMixRing = lazy(() => import("./model-mix-ring"));

const RING_MODELS = MODEL_COLORS.length;
const TABLE_ROWS = 5;

function ColorDot({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/** Ring of the top models by credits plus a table, cumulative since start or the last reset. */
export function ModelMixCard(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(modelMixQuery());
  const reducedMotion = usePrefersReducedMotion();
  const models = query.data;
  const otherLabel = t("modelMix.other");

  const mix = useMemo(() => {
    if (!models) return null;
    const { slices, metric } = modelSlices(models, RING_MODELS, otherLabel);
    const ring: RingSlice[] = slices.map((slice, index) => ({
      ...slice,
      color: index < RING_MODELS ? MODEL_COLORS[index] : OTHER_MODEL_COLOR,
    }));
    const metricOf = (m: ModelMixEntry) => (metric === "credits" ? m.credits : m.reqs);
    const sorted = [...models].sort((a, b) => metricOf(b) - metricOf(a));
    const colorOf = new Map(
      sorted.map((m, index) => [
        m.model,
        index < RING_MODELS ? MODEL_COLORS[index] : OTHER_MODEL_COLOR,
      ]),
    );
    return {
      ring,
      metric,
      rows: sorted.slice(0, TABLE_ROWS),
      rest: Math.max(0, sorted.length - TABLE_ROWS),
      colorOf,
    };
  }, [models, otherLabel]);

  const columns = useMemo<DataTableColumn<ModelMixEntry>[]>(
    () => [
      {
        id: "model",
        header: t("modelMix.model"),
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <ColorDot color={mix?.colorOf.get(row.model) ?? OTHER_MODEL_COLOR} />
            <span className="truncate font-mono text-xs">{row.model}</span>
          </span>
        ),
        className: "max-w-48",
      },
      {
        id: "reqs",
        header: t("modelMix.requests"),
        align: "end",
        cell: (row) => <span className="tabular-nums">{formatNumber(row.reqs, lang)}</span>,
      },
      {
        id: "tokens",
        header: t("modelMix.tokens"),
        cell: (row) => (
          <TokenCell
            cacheReadTokens={row.cacheReadTokens}
            cacheWriteTokens={row.cacheWriteTokens}
            inTokens={row.inTokens}
            outTokens={row.outTokens}
          />
        ),
        // The in/out/cache breakdown wraps instead of pushing Credits out of the card.
        className: "min-w-36 whitespace-normal",
      },
      {
        id: "credits",
        header: t("modelMix.credits"),
        align: "end",
        cell: (row) => <span className="tabular-nums">{formatCredits(row.credits)}</span>,
      },
    ],
    [t, lang, mix],
  );

  let body: JSX.Element;
  if (!models || !mix) {
    body = query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <div aria-hidden="true" className="flex flex-col items-center gap-4 @3xl:flex-row">
        <Skeleton className="size-48 shrink-0 rounded-full" />
        <TableSkeleton columns={4} rows={4} />
      </div>
    );
  } else if (models.length === 0) {
    body = (
      <EmptyState
        description={t("traffic.noTrafficBody")}
        icon={BoxesIcon}
        title={t("traffic.noTraffic")}
        variant="compact"
      />
    );
  } else {
    const credits = mix.metric === "credits";
    body = (
      <div className="flex flex-col gap-4">
        {query.isError ? (
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {/* Ring beside the table only when the card fits both (48rem); otherwise stacked. */}
        <div className="flex flex-col items-center gap-4 @3xl:flex-row @3xl:items-start">
          <figure
            aria-label={t(credits ? "modelMix.chartLabel" : "modelMix.chartLabelRequests")}
            className="w-full max-w-56 shrink-0"
          >
            <Suspense fallback={<Skeleton className="mx-auto aspect-square w-full rounded-full" />}>
              <ModelMixRing
                centerLabel={t(credits ? "modelMix.centerCredits" : "modelMix.centerRequests")}
                fractionDigits={credits ? 2 : 0}
                reducedMotion={reducedMotion}
                slices={mix.ring}
              />
            </Suspense>
          </figure>
          <div className="flex w-full min-w-0 flex-col gap-2">
            <ResponsiveList
              at="lg"
              caption={t("modelMix.title")}
              getRowId={(row) => row.model}
              renderCard={(row) => (
                <Card className="min-w-0 gap-2 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <ColorDot color={mix.colorOf.get(row.model) ?? OTHER_MODEL_COLOR} />
                      <span className="truncate font-mono text-xs">{row.model}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span className="text-muted-foreground text-xs">{t("modelMix.credits")}</span>
                      <span className="font-medium tabular-nums">{formatCredits(row.credits)}</span>
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-muted-foreground">{t("modelMix.requests")}</dt>
                      <dd className="tabular-nums">{formatNumber(row.reqs, lang)}</dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <dt className="text-muted-foreground">{t("modelMix.tokens")}</dt>
                      <dd className="min-w-0">
                        <TokenCell
                          cacheReadTokens={row.cacheReadTokens}
                          cacheWriteTokens={row.cacheWriteTokens}
                          inTokens={row.inTokens}
                          outTokens={row.outTokens}
                        />
                      </dd>
                    </div>
                  </dl>
                </Card>
              )}
              rows={mix.rows}
              table={
                <DataTable
                  caption={t("modelMix.title")}
                  columns={columns}
                  data={mix.rows}
                  getRowId={(row) => row.model}
                />
              }
            />
            {mix.rest > 0 ? (
              <p className="px-2 text-muted-foreground text-xs">
                {t("modelMix.moreModels", { count: mix.rest })}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      description={t("modelMix.description")}
      id="overview-model-mix"
      title={t("modelMix.title")}
    >
      {body}
    </SectionCard>
  );
}

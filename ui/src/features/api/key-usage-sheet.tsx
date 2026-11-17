import { ChartLineData02Icon, KeyRoundIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { Skeleton as SkulletSkeleton } from "skullet/react";
import { ChartLegendHoverProvider } from "@/components/charts/chart-legend-hover";
import {
  Legend,
  LegendItem,
  type LegendItemData,
  LegendLabel,
  LegendMarker,
  LegendValue,
} from "@/components/charts/legend";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
import { StatStrip } from "@/components/shared/stat-strip";
import { UnlimitedMark } from "@/components/shared/unlimited-mark";
import { Card } from "@/components/ui/card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { FAILED_COLOR, MODEL_COLORS, SUCCEEDED_COLOR } from "@/features/overview/colors";
import { PLOT_HEIGHT } from "@/features/overview/traffic-card";
import type { StackedBar, TrafficSeries } from "@/features/overview/traffic-chart";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageEntry,
  type ApiKeyUsageRange,
  type ApiKeyUsageResponse,
  type ApiKeyUsageTotals,
  apiKeyUsageBreakdownQuery,
  apiKeyUsageQuery,
} from "@/lib/api/api-key-usage";
import { apiKeysQuery } from "@/lib/api/api-keys";
import {
  EMPTY,
  formatCompact,
  formatCredits,
  formatDateTime,
  formatFraction,
  formatItems,
  formatNumber,
} from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { KeyStatus } from "./api-keys-card";
import { UsageBreakdownCard } from "./key-usage-breakdown";
import { type UsageIdentity, useUsageLabel } from "./key-usage-label";
import { KeyLimitsCard } from "./key-usage-limits";
import {
  EMPTY_TOTALS,
  findEntry,
  isUsageMetric,
  SHEET_METRICS,
  seriesBars,
  type UsageMetric,
} from "./key-usage-model";
import { SheetMark } from "./sheet-mark";

// The Overview's traffic chart: the same hatched bars, axes and tooltip.
const TrafficChart = lazy(() => import("@/features/overview/traffic-chart"));

function isRange(value: unknown): value is ApiKeyUsageRange {
  return typeof value === "string" && (API_KEY_USAGE_RANGES as readonly string[]).includes(value);
}

interface MetricSeries {
  primary: TrafficSeries;
  secondary?: TrafficSeries;
  values: (totals: ApiKeyUsageTotals) => [number, number?];
}

/** The two parts of each measure, in stack order: the legend dims the matching bars. */
function metricSeries(metric: UsageMetric, t: TFunction): MetricSeries {
  if (metric === "tokens") {
    return {
      primary: { label: t("usage.inputTokens"), color: MODEL_COLORS[0] },
      secondary: { label: t("usage.outputTokens"), color: MODEL_COLORS[2] },
      values: (totals) => [totals.inTokens, totals.outTokens],
    };
  }
  if (metric === "credits") {
    return {
      primary: { label: t("usage.metric.credits"), color: SUCCEEDED_COLOR },
      values: (totals) => [totals.credits],
    };
  }
  return {
    primary: { label: t("usage.succeeded"), color: SUCCEEDED_COLOR },
    secondary: { label: t("usage.failed"), color: FAILED_COLOR },
    values: (totals) => [totals.succeeded, totals.failed],
  };
}

interface ApiKeyUsageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row to chart (key-usage-model entryRef). */
  entryRef: string;
  /** Names the row while the data loads, or when the range has no traffic for it. */
  identity: UsageIdentity;
  initialRange?: ApiKeyUsageRange;
}

/** The 24h / 7d / 30d / Lifetime switch: a radio group, one tab stop, the arrow keys move it. */
export function UsageRangeControl({
  value,
  onValueChange,
  className,
}: {
  value: ApiKeyUsageRange;
  onValueChange: (range: ApiKeyUsageRange) => void;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <SegmentedControl
      className={className}
      render={
        <RadioGroupPrimitive
          aria-label={t("usage.range")}
          onValueChange={(next) => {
            if (isRange(next)) onValueChange(next);
          }}
          value={value}
        />
      }
      size="sm"
    >
      {API_KEY_USAGE_RANGES.map((range) => (
        <SegmentedControlItem key={range} render={<RadioPrimitive.Root value={range} />}>
          {t(`usage.range.${range}`)}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/**
 * A range's headline numbers (requests, failed with its share, credits, tokens) as a StatStrip;
 * put it in a `@container` card. `totals` undefined while the range loads: each number is then
 * a skullet bar measured from a sample of its size. A range without the key's traffic passes
 * EMPTY_TOTALS.
 */
function UsageTotalsStrip({
  totals,
  loading,
}: {
  totals: ApiKeyUsageTotals | undefined;
  loading: boolean;
}): JSX.Element {
  const { t, lang } = useT("api");
  const data = !loading;
  const stat = (content: ReactNode) => (
    <SkulletSkeleton label={t("common:state.loading")} loading={loading}>
      {content}
    </SkulletSkeleton>
  );
  return (
    <StatStrip
      items={[
        {
          label: t("usage.metric.requests"),
          value: stat(formatNumber(data ? (totals?.requests ?? 0) : 1234, lang)),
        },
        {
          label: t("usage.failed"),
          value:
            !data || (totals && totals.requests > 0) ? (
              stat(
                <span className="inline-flex items-baseline gap-1.5">
                  {formatNumber(data ? (totals?.failed ?? 0) : 12, lang)}
                  <span className="font-normal text-meta text-muted-foreground">
                    {formatFraction(
                      data && totals ? totals.failed / totals.requests : 0.01,
                      1,
                      lang,
                    )}
                  </span>
                </span>,
              )
            ) : (
              <span className="text-muted-foreground">{EMPTY}</span>
            ),
        },
        {
          label: t("usage.metric.credits"),
          value: stat(formatCredits(data ? (totals?.credits ?? 0) : 123.45, 2, lang)),
        },
        {
          label: t("usage.metric.tokens"),
          value: stat(formatCompact(data ? (totals?.tokens ?? 0) : 1_200_000, lang)),
        },
      ]}
    />
  );
}

interface UsageChartCardProps {
  /** The range's usage; undefined while it loads. */
  data: ApiKeyUsageResponse | undefined;
  /** The row to chart; undefined when the range has no traffic for it. */
  entry: ApiKeyUsageEntry | undefined;
  range: ApiKeyUsageRange;
  /** The usage query failed (with or without data from an earlier fetch). */
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  /** Layout only. */
  className?: string;
}

/**
 * One row's usage as a chart card: requests (succeeded and failed), tokens (input and output) or
 * credits per hour, day, week, month or year, behind a measure switch, with the legend's totals
 * over the chart. The chart is the Overview's traffic chart (hatched stacked bars over their
 * tracks), at its height. The loading state is the chart's own skeleton; an empty range keeps
 * the bare axis under a notice.
 */
export function UsageChartCard({
  data,
  entry,
  range,
  isError,
  error,
  retrying,
  onRetry,
  className,
}: UsageChartCardProps): JSX.Element {
  const { t, lang } = useT("api");
  const reducedMotion = usePrefersReducedMotion();
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const series = metricSeries(metric, t);
  const totals = entry?.totals;
  const empty = (totals?.requests ?? 0) === 0;
  // All time: requests pruned before daily totals were kept count in the totals, not in a bar.
  const earlier = entry?.earlier?.requests ?? 0;
  const bucket = data?.bucket ?? (range === "24h" ? "hour" : "day");
  const bucketSeconds = data?.bucketSeconds ?? (range === "24h" ? 3600 : 86400);
  const tzOffset = data?.tzOffset ?? 0;
  // Every range has the server's buckets (hours for 24h), labelled and titled by them.
  const period = useMemo(
    () => ({ bucket, bucketSeconds, tzOffset }),
    [bucket, bucketSeconds, tzOffset],
  );
  const stack = series.secondary ? [series.primary, series.secondary] : [series.primary];
  const bars = useMemo(
    (): StackedBar[] =>
      data
        ? seriesBars(data, entry, metric).map((bar) => ({
            date: new Date(bar.start * 1000),
            parts: [bar.primary, bar.secondary],
          }))
        : [],
    [data, entry, metric],
  );
  const formatValue = (value: number) =>
    metric === "credits" ? formatCredits(value, 2, lang) : formatNumber(value, lang);

  // Labels stay while a range loads (values follow the data), so switching moves nothing.
  const [first, second] = data ? series.values(totals ?? EMPTY_TOTALS) : [undefined, undefined];
  const legendItems: LegendItemData[] = [
    { label: series.primary.label, color: series.primary.color, value: first },
  ];
  if (series.secondary) {
    legendItems.push({
      label: series.secondary.label,
      color: series.secondary.color,
      value: second,
    });
  }
  const legend = (
    <Legend aria-label={t("usage.legend")} items={legendItems}>
      <LegendItem>
        <LegendMarker />
        <LegendLabel />
        <LegendValue formatValue={formatValue} />
      </LegendItem>
    </Legend>
  );
  // Until the chart code arrives, an empty box of the plot's height holds the layout.
  const placeholder = <div aria-hidden="true" className={PLOT_HEIGHT} />;

  const loading = !data;
  const showEmpty = !loading && empty;
  const errorState = (
    <ErrorState
      compact
      error={error}
      onRetry={onRetry}
      retrying={retrying}
      title={t("usage.loadFailed")}
    />
  );
  let body: JSX.Element;
  if (!data && isError) {
    body = errorState;
  } else {
    // One tree for loading and loaded: the legend stays put while a range loads.
    body = (
      <div className="flex flex-col gap-3">
        {data && isError ? errorState : null}
        {legend}
        <div className="relative">
          {/* Empty, the bare axis recedes, so the notice over it is what reads. */}
          <div aria-hidden="true" className={cn(showEmpty && "opacity-40")}>
            <Suspense fallback={placeholder}>
              <TrafficChart
                bars={bars}
                bucketMin={bucketSeconds / 60}
                empty={showEmpty}
                formatValue={formatValue}
                lang={lang}
                period={period}
                reducedMotion={reducedMotion}
                series={stack}
                status={loading ? "loading" : "ready"}
                wholeNumbers={metric !== "credits"}
              />
            </Suspense>
          </div>
          {showEmpty ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <EmptyState
                icon={ChartLineData02Icon}
                title={t("usage.emptyTitle")}
                variant="compact"
              />
            </div>
          ) : null}
        </div>
        {earlier > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("usage.earlierNote", { count: earlier, n: formatNumber(earlier, lang) })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ChartLegendHoverProvider>
      <SectionCard
        actions={
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("usage.metric")}
                onValueChange={(next) => {
                  if (isUsageMetric(next, SHEET_METRICS)) setMetric(next);
                }}
                value={metric}
              />
            }
            size="sm"
          >
            {SHEET_METRICS.map((value) => (
              <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
                {t(`usage.metric.${value}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        }
        className={className}
        description={range === "all" ? t(`usage.per.all.${bucket}`) : t(`usage.per.${range}`)}
        descriptionVariant="inline"
        icon={ChartLineData02Icon}
        title={t(`usage.metric.${metric}`)}
      >
        {body}
      </SectionCard>
    </ChartLegendHoverProvider>
  );
}

/**
 * One key's usage over 24 hours (hourly bars), 7 or 30 days (daily bars) or the lifetime (bars of
 * a day, week, month or year, by the span of the log): its headline numbers, a chart of requests
 * (succeeded and failed), tokens (input and output) or credits, donuts of the models and accounts
 * it used, and for a configured key its state, limits and dates. The usage reads the same query
 * as the Usage by key card, so opening it from there sends no request for it. Mount it with a
 * fresh `key` per opening so the range and measure start over.
 */
export function ApiKeyUsageSheet({
  open,
  onOpenChange,
  entryRef: ref,
  identity,
  initialRange = "24h",
}: ApiKeyUsageSheetProps): JSX.Element {
  const { t, lang } = useT("api");
  const label = useUsageLabel();
  const [range, setRange] = useState<ApiKeyUsageRange>(initialRange);
  const query = useQuery({ ...apiKeyUsageQuery(range), enabled: open });
  const breakdown = useQuery({ ...apiKeyUsageBreakdownQuery(ref, range), enabled: open });
  const keys = useQuery({ ...apiKeysQuery(), enabled: open });
  const data = query.data;
  const entry = findEntry(data, ref);
  // The configured key behind a key row: its state, limits and dates.
  const apiKey = ref.startsWith("key:")
    ? keys.data?.find((candidate) => `key:${candidate.id}` === ref)
    : undefined;
  // The latest name and masked key when the range has the row; what the opener knew otherwise.
  const shown = label(entry ?? identity);

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader>
        <div className="flex items-start gap-3">
          <SheetMark icon={shown.icon} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ResponsiveSheetTitle className="truncate">{shown.title}</ResponsiveSheetTitle>
            <ResponsiveSheetDescription
              className={cn("min-w-0 truncate", shown.keyMasked && "font-mono")}
            >
              {shown.keyMasked || shown.hint}
            </ResponsiveSheetDescription>
          </div>
        </div>
      </ResponsiveSheetHeader>
      <ResponsiveSheetPanel className="flex flex-col gap-4">
        <UsageRangeControl className="self-end" onValueChange={setRange} value={range} />
        {/* The range's headline numbers, as the account sheet's statistics. */}
        <Card className="@container min-w-0">
          <UsageTotalsStrip loading={!data} totals={entry?.totals} />
        </Card>
        <UsageChartCard
          data={data}
          entry={entry}
          error={query.error}
          isError={query.isError}
          onRetry={() => void query.refetch()}
          range={range}
          retrying={query.isFetching}
        />
        <UsageBreakdownCard
          accounts={breakdown.data?.accounts}
          error={breakdown.error}
          loading={breakdown.isPending}
          models={breakdown.data?.models}
          onRetry={() => void breakdown.refetch()}
          retrying={breakdown.isFetching}
        />
        {apiKey ? (
          <SectionCard icon={KeyRoundIcon} slim title={t("usage.keyDetails")}>
            {/* Label over value, two across: seven facts in four or five short rows. */}
            <div className="p-4">
              <KeyValueGrid
                items={[
                  // Its badges (state, label, routing) wrap less across the full width.
                  { label: t("keys.status"), value: <KeyStatus apiKey={apiKey} />, span: 2 },
                  {
                    label: t("form.allowedModels"),
                    value: apiKey.allowedModels?.length
                      ? formatItems(apiKey.allowedModels, lang)
                      : t("form.modelsAll"),
                    // A list of models takes the full width; "Every model" pairs up.
                    span: apiKey.allowedModels?.length ? 2 : 1,
                  },
                  {
                    label: t("usage.allowedAccounts"),
                    value: apiKey.accountIds?.length
                      ? t("keys.boundAccounts", {
                          count: apiKey.accountIds.length,
                          n: formatNumber(apiKey.accountIds.length, lang),
                        })
                      : t("usage.everyAccount"),
                  },
                  {
                    label: t("form.rpmLimit"),
                    value: apiKey.rpmLimit ? (
                      t("keys.rpmLimit", { n: formatNumber(apiKey.rpmLimit, lang) })
                    ) : (
                      <UnlimitedMark />
                    ),
                  },
                  {
                    label: t("form.expiresAt"),
                    value: apiKey.expiresAt
                      ? apiKey.expired
                        ? t("usage.expiredAt", { time: formatDateTime(apiKey.expiresAt, lang) })
                        : formatDateTime(apiKey.expiresAt, lang)
                      : t("usage.never"),
                  },
                  {
                    label: t("keys.lastUsed"),
                    value: apiKey.lastUsedAt ? (
                      <RelativeTime value={apiKey.lastUsedAt} />
                    ) : (
                      t("keys.neverUsed")
                    ),
                  },
                  { label: t("usage.created"), value: formatDateTime(apiKey.createdAt, lang) },
                ]}
              />
            </div>
          </SectionCard>
        ) : null}
        {apiKey ? <KeyLimitsCard apiKey={apiKey} /> : null}
      </ResponsiveSheetPanel>
    </ResponsiveSheet>
  );
}

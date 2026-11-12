import { ChartLineData02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, Suspense, useMemo, useState } from "react";
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
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { FAILED_COLOR, MODEL_COLORS, SUCCEEDED_COLOR } from "@/features/overview/colors";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageRange,
  type ApiKeyUsageTotals,
  apiKeyUsageQuery,
} from "@/lib/api/api-key-usage";
import { formatCredits, formatNumber } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { UsageSeries } from "./key-usage-chart";
import { type UsageIdentity, useUsageLabel } from "./key-usage-label";
import {
  EMPTY_TOTALS,
  findEntry,
  isUsageMetric,
  SHEET_METRICS,
  seriesBars,
  USAGE_PLOT_HEIGHT,
  type UsageMetric,
} from "./key-usage-model";

const KeyUsageChart = lazy(() => import("./key-usage-chart"));

function isRange(value: unknown): value is ApiKeyUsageRange {
  return typeof value === "string" && (API_KEY_USAGE_RANGES as readonly string[]).includes(value);
}

interface MetricSeries {
  primary: UsageSeries;
  secondary?: UsageSeries;
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

export interface ApiKeyUsageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row to chart (key-usage-model entryRef). */
  entryRef: string;
  /** Names the row while the data loads, or when the range has no traffic for it. */
  identity: UsageIdentity;
  initialRange?: ApiKeyUsageRange;
}

/**
 * One key's usage over 24 hours (hourly bars) or 7 or 30 days (daily bars): requests split
 * succeeded and failed, tokens split input and output, or credits. It reads the same query as the
 * Usage by key card, so opening it from there sends no request. Mount it with a fresh `key` per
 * opening so the range and measure start over.
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
  const reducedMotion = usePrefersReducedMotion();
  const [range, setRange] = useState<ApiKeyUsageRange>(initialRange);
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const query = useQuery({ ...apiKeyUsageQuery(range), enabled: open });
  const data = query.data;
  const entry = findEntry(data, ref);
  // The latest name and masked key when the range has the row; what the opener knew otherwise.
  const shown = label(entry ?? identity);
  const series = metricSeries(metric, t);
  const totals = entry?.totals;
  const empty = (totals?.requests ?? 0) === 0;
  const bars = useMemo(() => (data ? seriesBars(data, entry, metric) : []), [data, entry, metric]);
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
  const placeholder = <div aria-hidden="true" className={USAGE_PLOT_HEIGHT} />;

  const loading = !data;
  const showEmpty = !loading && empty;
  let body: JSX.Element;
  if (!data && query.isError) {
    body = (
      <ErrorState
        compact
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        title={t("usage.loadFailed")}
      />
    );
  } else {
    // One tree for loading and loaded: the legend stays put while a range loads.
    body = (
      <div className="flex flex-col gap-3">
        {data && query.isError ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            title={t("usage.loadFailed")}
          />
        ) : null}
        {legend}
        <div className="relative">
          {/* Empty, the bare axis recedes, so the notice over it is what reads. */}
          <div aria-hidden="true" className={cn(showEmpty && "opacity-40")}>
            <Suspense fallback={placeholder}>
              <KeyUsageChart
                bars={bars}
                bucket={data?.bucket ?? (range === "24h" ? "hour" : "day")}
                bucketSeconds={data?.bucketSeconds ?? (range === "24h" ? 3600 : 86400)}
                empty={showEmpty}
                formatValue={formatValue}
                lang={lang}
                primary={series.primary}
                reducedMotion={reducedMotion}
                secondary={series.secondary}
                status={loading ? "loading" : "ready"}
                tzOffset={data?.tzOffset ?? 0}
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
      </div>
    );
  }

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader>
        <div className="flex items-start gap-3">
          {/* The row's mark on the account sheet's avatar tile. Decorative. */}
          <span
            aria-hidden="true"
            className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-2"
          >
            <HugeiconsIcon className="size-5 text-muted-foreground" icon={shown.icon} />
          </span>
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
        {/* Two radio groups; at 390 px the measure wraps under the range. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("usage.range")}
                onValueChange={(next) => {
                  if (isRange(next)) setRange(next);
                }}
                value={range}
              />
            }
            size="sm"
          >
            {API_KEY_USAGE_RANGES.map((value) => (
              <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
                {t(`usage.range.${value}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
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
        </div>
        <ChartLegendHoverProvider>
          <SectionCard
            description={t(`usage.per.${range}`)}
            descriptionVariant="inline"
            icon={ChartLineData02Icon}
            title={t(`usage.metric.${metric}`)}
          >
            {body}
          </SectionCard>
        </ChartLegendHoverProvider>
      </ResponsiveSheetPanel>
    </ResponsiveSheet>
  );
}

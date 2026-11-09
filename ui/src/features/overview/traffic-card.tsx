import { ChartLineData02Icon, Pulse01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, lazy, Suspense, useMemo } from "react";
import { ChartLegendHoverProvider } from "@/components/charts/chart-legend-hover";
import {
  Legend,
  LegendItem,
  type LegendItemData,
  LegendLabel,
  LegendMarker,
  LegendValue,
  useLegendItem,
} from "@/components/charts/legend";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { useIsMobile } from "@/hooks/use-media-query";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { heatmapQuery } from "@/lib/api/observe";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { OverviewRange } from "@/routes/-search";
import {
  bucketGlobal,
  bucketRetries,
  HOUR,
  HOUR_PAIR_WINDOW,
  RANGE_WINDOWS,
  withPreviousWindow,
} from "./aggregate";
import { FAILED_COLOR, PREVIOUS_COLOR, RETRIED_COLOR, SUCCEEDED_COLOR } from "./colors";
import { useTotalsFailed } from "./totals";

const TrafficChart = lazy(() => import("./traffic-chart"));

const RANGES: readonly OverviewRange[] = ["1h", "6h", "24h"];
/** Bucket minutes on a phone: 15 bars for 1 h, 18 for 6 h, 24 for 24 h. */
const PHONE_BUCKET_MIN: Readonly<Record<OverviewRange, number>> = { "1h": 4, "6h": 20, "24h": 60 };
/** The plot's height, sized by the card's width (SectionCard is a container), not the viewport. */
export const PLOT_HEIGHT = "h-64 @2xl:h-72";

function isRange(value: unknown): value is OverviewRange {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

/** The legend key of the dashed previous-hour series, which only the 1 h view draws. */
const PREVIOUS_KEY = "previous";

/**
 * A legend entry (marker, label, value). With `reservePrevious` the previous-hour entry keeps its
 * place but is not shown, so the legend is as wide on 6 h and 24 h as on 1 h and switching the
 * range moves nothing.
 */
function TrafficLegendItem({
  reservePrevious = false,
}: {
  reservePrevious?: boolean;
}): JSX.Element {
  const { item } = useLegendItem();
  return (
    <LegendItem className={cn(reservePrevious && item.key === PREVIOUS_KEY && "invisible")}>
      <LegendMarker />
      <LegendLabel />
      <LegendValue />
    </LegendItem>
  );
}

/**
 * Port of Studio's performance overview: succeeded, retried and failed requests over 1, 6 or
 * 24 h as hatched stacked bars, with the previous hour dashed over the 1 h view. The range pill
 * sits in the header, top right at every width; the legend with its totals opens the panel.
 */
export function TrafficCard(): JSX.Element {
  const { t, lang } = useT("overview");
  // An unknown `?range=` must not crash the page, even if it slips past the route validator.
  const { range: rawRange } = useSearch({ from: "/_app/" });
  const range: OverviewRange = isRange(rawRange) ? rawRange : "1h";
  const navigate = useNavigate({ from: "/" });
  const reducedMotion = usePrefersReducedMotion();
  const totalsFailed = useTotalsFailed();
  // Phones draw half as many bars (or fewer), each wider: 30 two-minute bars were slivers there.
  const phone = useIsMobile();
  const { windowMin } = RANGE_WINDOWS[range];
  const bucketMin = phone ? PHONE_BUCKET_MIN[range] : RANGE_WINDOWS[range].bucketMin;
  const hourView = range === "1h";
  // Only the global row is read (scope=global: no per-account rows on the wire). The 1 h view
  // reads the two-hour heatmap the status cards already load (same key, no extra request), and
  // takes its older hour as the dashed comparison. It follows SSE ticks; the longer ranges poll
  // every 60 s.
  const query = useQuery(
    heatmapQuery(hourView ? HOUR_PAIR_WINDOW : windowMin, { live: hourView, scope: "global" }),
  );
  const data = query.data;

  const bars = useMemo(() => {
    if (!data) return [];
    const points = hourView
      ? withPreviousWindow(data.global.cells, data.nowUnix, bucketMin, HOUR)
      : bucketGlobal(data.global.cells, data.nowUnix, bucketMin, windowMin);
    const retries = bucketRetries(data.global.cells, bucketMin, hourView ? HOUR : windowMin);
    return points.map((point, index) => ({ ...point, retried: retries[index] ?? 0 }));
  }, [data, hourView, bucketMin, windowMin]);
  const totals = useMemo(
    () =>
      bars.reduce(
        (sum, p) => ({
          succeeded: sum.succeeded + p.succeeded,
          retried: sum.retried + p.retried,
          failed: sum.failed + p.failed,
          previous: sum.previous + (p.previous ?? 0),
        }),
        { succeeded: 0, retried: 0, failed: 0, previous: 0 },
      ),
    [bars],
  );
  // Empty only when nothing at all is drawn: in the 1 h view the previous hour's dashed line
  // alone is still traffic to show, so it keeps the chart instead of "No traffic yet".
  const empty = totals.succeeded + totals.retried + totals.failed + totals.previous === 0;

  const setRange = (value: unknown) => {
    if (!isRange(value)) return;
    void navigate({
      search: (prev) => ({ ...prev, range: value === "1h" ? undefined : value }),
    });
  };

  const labels = {
    succeeded: t("traffic.succeeded"),
    retried: t("traffic.retried"),
    failed: t("traffic.failed"),
    previous: t("traffic.previous"),
    bucket: t("traffic.bucket", { n: formatNumber(bucketMin, lang) }),
  };
  // Series order, so hovering an item dims the others in the chart. The previous hour keeps its
  // slot outside 1 h (hidden), and the labels stay up while a range loads (the values follow the
  // data), so switching the range does not move the card.
  const known = (n: number) => (data ? n : undefined);
  const legendItems: LegendItemData[] = [
    { label: labels.succeeded, color: SUCCEEDED_COLOR, value: known(totals.succeeded) },
    { label: labels.retried, color: RETRIED_COLOR, value: known(totals.retried) },
    { label: labels.failed, color: FAILED_COLOR, value: known(totals.failed) },
    {
      key: PREVIOUS_KEY,
      label: labels.previous,
      color: PREVIOUS_COLOR,
      marker: "dashed",
      value: known(totals.previous),
    },
  ];
  const legend = (
    <Legend aria-label={t("traffic.legend")} items={legendItems}>
      <TrafficLegendItem reservePrevious={!hourView} />
    </Legend>
  );
  const loadingChart = (
    <TrafficChart
      bars={[]}
      bucketMin={bucketMin}
      labels={labels}
      lang={lang}
      reducedMotion={reducedMotion}
      status="loading"
    />
  );
  // Until the chart code arrives, an empty box of the plot's height holds the layout.
  const placeholder = <div aria-hidden="true" className={PLOT_HEIGHT} />;

  let body: JSX.Element;
  if (!data) {
    if (query.isError) {
      body = totalsFailed ? (
        <ErrorState notLoaded />
      ) : (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("errors.traffic")}
        />
      );
    } else {
      body = (
        <div className="flex flex-col gap-3">
          {legend}
          <div aria-hidden="true">
            <Suspense fallback={placeholder}>{loadingChart}</Suspense>
          </div>
        </div>
      );
    }
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {query.isError && !totalsFailed ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
            title={t("errors.traffic")}
          />
        ) : null}
        <p className="sr-only">
          {t("traffic.summary", {
            succeeded: formatNumber(totals.succeeded, lang),
            failed: formatNumber(totals.failed, lang),
          })}
        </p>
        {legend}
        <div className="relative">
          {/* Empty, the bare axes recede, so the notice over them is what reads. */}
          <div aria-hidden="true" className={cn(empty && "opacity-40")}>
            <Suspense fallback={placeholder}>
              <TrafficChart
                bars={bars}
                bucketMin={bucketMin}
                empty={empty}
                labels={labels}
                lang={lang}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          </div>
          {empty ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <EmptyState
                description={t("traffic.noTrafficBody")}
                icon={Pulse01Icon}
                title={t("traffic.noTraffic")}
                variant="compact"
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <ChartLegendHoverProvider>
      <SectionCard
        actions={
          // A radio group: one tab stop, the arrow keys move the range.
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("traffic.range")}
                onValueChange={setRange}
                value={range}
              />
            }
            size="sm"
          >
            {RANGES.map((value) => (
              <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
                {t(`traffic.range.${value}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        }
        description={t(`traffic.description.${range}`, { n: formatNumber(bucketMin, lang) })}
        descriptionVariant="inline"
        icon={ChartLineData02Icon}
        id="overview-traffic"
        title={t("traffic.title")}
      >
        {body}
      </SectionCard>
    </ChartLegendHoverProvider>
  );
}

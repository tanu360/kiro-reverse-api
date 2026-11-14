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
import { heatmapQuery, trafficHistoryQuery } from "@/lib/api/observe";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { OverviewRange } from "@/routes/-search";
import {
  bucketGlobal,
  bucketRetries,
  type HeatmapRange,
  HOUR,
  HOUR_PAIR_WINDOW,
  RANGE_WINDOWS,
  withPreviousWindow,
} from "./aggregate";
import { FAILED_COLOR, PREVIOUS_COLOR, RETRIED_COLOR, SUCCEEDED_COLOR } from "./colors";
import { useTotalsFailed } from "./totals";
import type { TrafficBar } from "./traffic-chart";

const TrafficChart = lazy(() => import("./traffic-chart"));

const RANGES: readonly OverviewRange[] = ["1h", "6h", "24h", "all"];
/** Bucket minutes on a phone: 15 bars for 1 h, 18 for 6 h, 24 for 24 h. */
const PHONE_BUCKET_MIN: Readonly<Record<HeatmapRange, number>> = { "1h": 4, "6h": 20, "24h": 60 };
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
 * 24 h as hatched stacked bars, with the previous hour dashed over the 1 h view. All time draws
 * the request log by day, week, month or year instead, and its legend totals match the lifetime
 * totals. The range pill sits in the header, top right at every width; the legend with its totals
 * opens the panel.
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
  const allTime = range === "all";
  // All time keeps the 24 h window for the (disabled) heatmap query, so no hook changes order.
  const heatRange: HeatmapRange = allTime ? "24h" : range;
  const { windowMin } = RANGE_WINDOWS[heatRange];
  const bucketMin = phone ? PHONE_BUCKET_MIN[heatRange] : RANGE_WINDOWS[heatRange].bucketMin;
  const hourView = range === "1h";
  // Only the global row is read (scope=global: no per-account rows on the wire). The 1 h view
  // reads the two-hour heatmap the status cards already load (same key, no extra request), and
  // takes its older hour as the dashed comparison. It follows SSE ticks; the longer ranges poll
  // every 60 s. All time reads the request log by day or longer and polls every 5 minutes.
  const heatmap = useQuery({
    ...heatmapQuery(hourView ? HOUR_PAIR_WINDOW : windowMin, { live: hourView, scope: "global" }),
    enabled: !allTime,
  });
  const history = useQuery({ ...trafficHistoryQuery(), enabled: allTime });
  const query = allTime ? history : heatmap;
  const heat = allTime ? undefined : heatmap.data;
  const past = allTime ? history.data : undefined;
  const data = allTime ? past : heat;

  const bars = useMemo((): TrafficBar[] => {
    if (past) {
      return past.buckets.map((start, index) => {
        const counts = past.series[index];
        return {
          date: new Date(start * 1000),
          succeeded: counts?.succeeded ?? 0,
          failed: counts?.failed ?? 0,
          retried: counts?.retried ?? 0,
        };
      });
    }
    if (!heat) return [];
    const points = hourView
      ? withPreviousWindow(heat.global.cells, heat.nowUnix, bucketMin, HOUR)
      : bucketGlobal(heat.global.cells, heat.nowUnix, bucketMin, windowMin);
    const retries = bucketRetries(heat.global.cells, bucketMin, hourView ? HOUR : windowMin);
    return points.map((point, index) => ({ ...point, retried: retries[index] ?? 0 }));
  }, [past, heat, hourView, bucketMin, windowMin]);
  const totals = useMemo(
    () =>
      // All time: the server's totals, which also count the traffic that has no day.
      past
        ? { ...past.totals, previous: 0 }
        : bars.reduce(
            (sum, p) => ({
              succeeded: sum.succeeded + p.succeeded,
              retried: sum.retried + p.retried,
              failed: sum.failed + p.failed,
              previous: sum.previous + (p.previous ?? 0),
            }),
            { succeeded: 0, retried: 0, failed: 0, previous: 0 },
          ),
    [past, bars],
  );
  const earlier = past?.earlier ? past.earlier.succeeded + past.earlier.failed : 0;
  // All time's bars and title follow the bucket the server picked for the span of the log.
  const period = past
    ? { bucket: past.bucket, bucketSeconds: past.bucketSeconds, tzOffset: past.tzOffset }
    : undefined;
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
      period={period}
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
                period={period}
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
        {earlier > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("traffic.earlierNote", { count: earlier, n: formatNumber(earlier, lang) })}
          </p>
        ) : null}
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
        description={
          allTime
            ? t(`traffic.description.all.${past?.bucket ?? "day"}`)
            : t(`traffic.description.${range}`, { n: formatNumber(bucketMin, lang) })
        }
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

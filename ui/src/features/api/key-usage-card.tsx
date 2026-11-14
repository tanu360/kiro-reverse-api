import { ChartColumnIcon, MoreHorizontalCircle01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { MODEL_COLORS, OTHER_MODEL_COLOR, TRACK_COLOR } from "@/features/overview/colors";
import { LazySparkline } from "@/features/overview/lazy-sparkline";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageRange,
  type ApiKeyUsageTotals,
  apiKeyUsageQuery,
} from "@/lib/api/api-key-usage";
import { settingsQuery } from "@/lib/api/settings";
import { formatCredits, formatFraction, formatNumber, formatPercent } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { placeholderKeys } from "@/lib/utils";
import { type UsageIdentity, useUsageLabel } from "./key-usage-label";
import {
  addTotals,
  CARD_METRICS,
  EMPTY_TOTALS,
  entryRef,
  isUsageMetric,
  metricAmount,
  rankEntries,
  TOP_KEYS,
  type UsageMetric,
} from "./key-usage-model";
import { ApiKeyUsageSheet } from "./key-usage-sheet";

/** A full list's rows while loading: the top keys and the others. */
const ROW_PLACEHOLDERS = placeholderKeys("row", TOP_KEYS + 1);

function isRange(value: unknown): value is ApiKeyUsageRange {
  return typeof value === "string" && (API_KEY_USAGE_RANGES as readonly string[]).includes(value);
}

/** A failure rate from this share up reads as a problem: the badge turns red. */
const HIGH_FAILURE_RATE = 0.05;

/**
 * One grid for the column heads and every row. A phone shows the key, the measure picked and the
 * failure rate; a wider card adds the trend, and requests and credits each get a column.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-x-4 [grid-template-areas:'name_value_failed'] @lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5.5rem_4.5rem_5rem] @lg:[grid-template-areas:'name_trend_requests_failed_credits']";

interface Row {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  /** The opener's accessible name; none for the "other keys" row, which opens nothing. */
  openLabel?: string;
  /** What the sheet shows while it loads. */
  identity?: UsageIdentity;
  other: boolean;
  totals: ApiKeyUsageTotals;
  /** One per bucket, oldest first: the trend line. */
  series: readonly ApiKeyUsageTotals[];
  /** The row's series colour, by rank as the Overview's traffic by account. */
  color: string;
}

interface SheetState {
  ref: string;
  identity: UsageIdentity;
  range: ApiKeyUsageRange;
  open: boolean;
  /** Bumped on every opening, so the sheet remounts with the card's range. */
  session: number;
}

/**
 * Usage by key over 24 hours, 7 or 30 days or all time, from the request log (All time adds the
 * totals log retention kept of pruned rows): the five busiest keys by requests or credits, the
 * rest as one row. Each row has a share bar under the name, a trend line over the range, and its
 * requests, failure rate and credits. No API key, invalid keys and deleted keys are rows of their
 * own. A row opens that key's usage chart.
 */
export function KeyUsageCard(): JSX.Element {
  const { t, lang } = useT("api");
  const label = useUsageLabel();
  const [range, setRange] = useState<ApiKeyUsageRange>("24h");
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const query = useQuery(apiKeyUsageQuery(range));
  const settings = useQuery(settingsQuery());
  const data = query.data;

  const rows = useMemo((): Row[] => {
    if (!data) return [];
    const ranked = rankEntries(data.keys, metric);
    const named: Row[] = ranked.rows.map((entry, index) => {
      const shown = label(entry);
      let text: ReactNode;
      if (shown.group) {
        text = (
          <>
            <span className="min-w-0 truncate text-muted-foreground">{shown.title}</span>
            {/* The masked key tells two deleted keys apart, so the group name gives way first. */}
            {shown.keyMasked ? (
              <span className="shrink-0 font-mono text-meta text-muted-foreground">
                {shown.keyMasked}
              </span>
            ) : null}
          </>
        );
      } else if (!shown.named && shown.keyMasked) {
        // An unnamed key goes by its masked value: "Unnamed key" twice would tell them apart.
        text = <span className="min-w-0 truncate font-mono text-meta">{shown.keyMasked}</span>;
      } else {
        text = <span className="min-w-0 truncate">{shown.title}</span>;
      }
      return {
        key: entryRef(entry),
        icon: (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
            icon={shown.icon}
          />
        ),
        label: text,
        openLabel: t("usage.open", {
          name: shown.named || !shown.keyMasked ? shown.title : shown.keyMasked,
        }),
        identity: { kind: entry.kind, name: entry.name, keyMasked: entry.keyMasked },
        other: false,
        totals: entry.totals,
        series: entry.series,
        color: MODEL_COLORS[index % MODEL_COLORS.length],
      };
    });
    if (!ranked.other) return named;
    const count = ranked.other.count;
    const shown = new Set(ranked.rows.map(entryRef));
    const rest = data.keys.filter((entry) => !shown.has(entryRef(entry)));
    const otherSeries = data.buckets.map((_, index) =>
      rest.reduce(
        (sum, entry) => addTotals(sum, entry.series[index] ?? EMPTY_TOTALS),
        EMPTY_TOTALS,
      ),
    );
    return [
      ...named,
      {
        key: "other",
        icon: (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
            icon={MoreHorizontalCircle01Icon}
          />
        ),
        label: (
          <span className="min-w-0 truncate text-muted-foreground">
            {t("usage.otherKeys", { count, n: formatNumber(count, lang) })}
          </span>
        ),
        other: true,
        totals: ranked.other.totals,
        series: otherSeries,
        color: OTHER_MODEL_COLOR,
      },
    ];
  }, [data, metric, label, t, lang]);

  // The busiest named row fills the track; the others row is capped at full width.
  const scale = Math.max(
    1e-9,
    ...rows.filter((row) => !row.other).map((row) => metricAmount(row.totals, metric)),
  );
  const onlyKeyless =
    data !== undefined && data.keys.length > 0 && data.keys.every((entry) => entry.kind === "none");
  // Keyless traffic means the requirement is off, or, with it on, clients that send no key and
  // get a 401. No hint until the setting has loaded.
  const requireApiKey = settings.data?.requireApiKey;

  const openSheet = (row: Row) => {
    if (!row.identity) return;
    const identity = row.identity;
    setSheet((current) => ({
      ref: row.key,
      identity,
      range,
      open: true,
      session: (current?.session ?? 0) + 1,
    }));
  };

  const skeleton = (
    <ul aria-hidden="true" className="flex flex-col gap-3 py-1">
      {ROW_PLACEHOLDERS.map((key) => (
        <li className="flex items-center gap-4" key={key}>
          <Skeleton className="h-4 w-40 shrink-0" />
          <Skeleton className="h-3 flex-1 rounded-sm" />
          <Skeleton className="h-4 w-12 shrink-0" />
        </li>
      ))}
    </ul>
  );

  let body: JSX.Element;
  if (!data) {
    body = query.isError ? (
      <ErrorState
        compact
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        title={t("usage.loadFailed")}
      />
    ) : (
      skeleton
    );
  } else if (data.keys.length === 0) {
    body = (
      <EmptyState
        description={t("usage.emptyBody")}
        icon={ChartColumnIcon}
        title={t("usage.emptyTitle")}
        variant="compact"
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {query.isError ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            title={t("usage.loadFailed")}
          />
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* A radio group: one tab stop, the arrow keys switch the measure. */}
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("usage.metric")}
                onValueChange={(next) => {
                  if (isUsageMetric(next, CARD_METRICS)) setMetric(next);
                }}
                value={metric}
              />
            }
            size="sm"
          >
            {CARD_METRICS.map((item) => (
              <SegmentedControlItem key={item} render={<RadioPrimitive.Root value={item} />}>
                {t(`usage.metric.${item}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <span className="text-muted-foreground text-sm tabular-nums">
            {metric === "credits"
              ? t("usage.creditsTotal", { n: formatCredits(data.totals.credits, 2, lang) })
              : t("usage.requestsCount", {
                  count: data.totals.requests,
                  n: formatNumber(data.totals.requests, lang),
                })}
          </span>
        </div>
        <div className="-mx-2 flex flex-col gap-1">
          {/* Column heads for sighted readers; each value also carries its name for a screen reader. */}
          <div aria-hidden="true" className={`${ROW_GRID} px-2 text-meta text-muted-foreground`}>
            <span className="[grid-area:name]">{t("usage.col.key")}</span>
            <span className="hidden @lg:block @lg:[grid-area:trend]">{t("usage.col.trend")}</span>
            <span
              className={`text-right ${metric === "credits" ? "hidden @lg:block" : "[grid-area:value]"} @lg:[grid-area:requests]`}
            >
              {t("usage.metric.requests")}
            </span>
            <span className="text-right [grid-area:failed]">{t("usage.failed")}</span>
            <span
              className={`text-right ${metric === "requests" ? "hidden @lg:block" : "[grid-area:value]"} @lg:[grid-area:credits]`}
            >
              {t("usage.metric.credits")}
            </span>
          </div>
          {/* The name is a button stretched over the row, so the whole row opens the key's chart. */}
          <ul aria-label={t("usage.list")} className="flex flex-col gap-1">
            {rows.map((row) => {
              const amount = metricAmount(row.totals, metric);
              const share = Math.min(100, (amount / scale) * 100);
              const points = row.series.map((totals) => ({ value: metricAmount(totals, metric) }));
              const rate = row.totals.requests > 0 ? row.totals.failed / row.totals.requests : 0;
              return (
                <li
                  className={`relative ${ROW_GRID} rounded-md px-2 py-2 text-sm has-[button:hover]:bg-(--row-hover) @lg:min-h-12`}
                  key={row.key}
                >
                  <div className="flex min-w-0 flex-col gap-1.5 [grid-area:name]">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {row.icon}
                      </span>
                      {row.openLabel ? (
                        <button
                          aria-label={row.openLabel}
                          className="flex min-w-0 cursor-pointer items-baseline gap-2 text-start outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-ring focus-visible:after:outline-solid"
                          onClick={() => openSheet(row)}
                          type="button"
                        >
                          {row.label}
                        </button>
                      ) : (
                        <span className="flex min-w-0 items-baseline gap-2">{row.label}</span>
                      )}
                    </div>
                    <div
                      aria-hidden="true"
                      className="ms-6.5 h-1 overflow-hidden rounded-full"
                      style={{ background: TRACK_COLOR }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${share}%`, background: row.color }}
                      />
                    </div>
                  </div>
                  <div aria-hidden="true" className="hidden h-7 @lg:block @lg:[grid-area:trend]">
                    {points.length > 1 ? (
                      <LazySparkline
                        animate
                        color={row.color}
                        data={points}
                        idle={points.every((point) => point.value === 0)}
                      />
                    ) : null}
                  </div>
                  <div
                    className={`text-right font-medium tabular-nums ${metric === "credits" ? "hidden @lg:block" : "[grid-area:value]"} @lg:[grid-area:requests]`}
                  >
                    <span className="sr-only">
                      {t("usage.requestsCount", {
                        count: row.totals.requests,
                        n: formatNumber(row.totals.requests, lang),
                      })}
                    </span>
                    <span aria-hidden="true">{formatNumber(row.totals.requests, lang)}</span>
                  </div>
                  <div className="flex justify-end [grid-area:failed]">
                    {row.totals.requests > 0 ? (
                      <>
                        <span className="sr-only">
                          {t("usage.failedCount", {
                            count: row.totals.failed,
                            n: formatNumber(row.totals.failed, lang),
                          })}
                        </span>
                        <Badge
                          aria-hidden="true"
                          className="tabular-nums"
                          size="sm"
                          tone={rate >= HIGH_FAILURE_RATE ? "destructive" : "neutral"}
                        >
                          {/* One decimal keeps the column narrow; no failures read 0%, not 0.0%. */}
                          {row.totals.failed > 0
                            ? formatFraction(rate, 1, lang)
                            : formatPercent(0, row.totals.requests, lang)}
                        </Badge>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div
                    className={`text-right tabular-nums ${metric === "requests" ? "hidden text-muted-foreground @lg:block" : "font-medium [grid-area:value] @lg:font-normal @lg:text-muted-foreground"} @lg:[grid-area:credits]`}
                  >
                    <span className="sr-only">
                      {t("usage.creditsTotal", { n: formatCredits(row.totals.credits, 2, lang) })}
                    </span>
                    <span aria-hidden="true">{formatCredits(row.totals.credits, 2, lang)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        {onlyKeyless && requireApiKey !== undefined ? (
          <p className="text-muted-foreground text-sm">
            {t(requireApiKey ? "usage.keylessRejected" : "usage.notTracked")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <SectionCard
      actions={
        // A radio group: one tab stop, the arrow keys move the range.
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
      }
      description={t(`usage.description.${range}`)}
      descriptionVariant="inline"
      icon={ChartColumnIcon}
      id="api-key-usage"
      title={t("usage.title")}
    >
      {body}
      {sheet ? (
        <ApiKeyUsageSheet
          entryRef={sheet.ref}
          identity={sheet.identity}
          initialRange={sheet.range}
          key={sheet.session}
          onOpenChange={(open) => setSheet((current) => (current ? { ...current, open } : null))}
          open={sheet.open}
        />
      ) : null}
    </SectionCard>
  );
}

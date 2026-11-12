import { ChartColumnIcon, MoreHorizontalCircle01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type JSX, type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { FAILED_COLOR, OTHER_MODEL_COLOR, SUCCEEDED_COLOR } from "@/features/overview/colors";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageRange,
  type ApiKeyUsageTotals,
  apiKeyUsageQuery,
} from "@/lib/api/api-key-usage";
import { formatCredits, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { placeholderKeys } from "@/lib/utils";
import { type UsageIdentity, useUsageLabel } from "./key-usage-label";
import {
  CARD_METRICS,
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

/** Diagonal hatching in one series colour, as the Overview's traffic-by-account bars. */
function hatch(color: string): CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in oklab, ${color} 30%, var(--card)) 3px 6px)`,
  };
}

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
 * Usage by key over 24 hours, 7 or 30 days, from the request log: the five busiest keys by
 * requests or credits as hatched bars (failed requests in red at the end), the rest as one
 * lighter row, as the Overview's traffic by account. No API key, invalid keys and deleted keys
 * are rows of their own. A row opens that key's usage chart.
 */
export function KeyUsageCard(): JSX.Element {
  const { t, lang } = useT("api");
  const label = useUsageLabel();
  const [range, setRange] = useState<ApiKeyUsageRange>("24h");
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const query = useQuery(apiKeyUsageQuery(range));
  const data = query.data;

  const rows = useMemo((): Row[] => {
    if (!data) return [];
    const ranked = rankEntries(data.keys, metric);
    const named: Row[] = ranked.rows.map((entry) => {
      const shown = label(entry);
      let text: ReactNode;
      if (shown.group) {
        text = (
          <>
            <span className="min-w-0 truncate text-muted-foreground">{shown.title}</span>
            {shown.keyMasked ? (
              <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
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
      };
    });
    if (!ranked.other) return named;
    const count = ranked.other.count;
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
        {/*
          Each row: the key, its bar and its numbers. A phone puts the name and numbers on one
          line and the bar under the name; a wider card lays the three side by side. The name is
          a button stretched over the row, so the whole row opens the key's chart.
        */}
        <ul aria-label={t("usage.list")} className="-mx-2 flex flex-col gap-1">
          {rows.map((row) => {
            const amount = metricAmount(row.totals, metric);
            const width = Math.min(100, (amount / scale) * 100);
            // Credits have no failed part; requests end in their failures.
            const failed = metric === "requests" ? row.totals.failed : 0;
            const passed = Math.max(0, amount - failed);
            return (
              <li
                className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-1.5 text-sm [grid-template-areas:'name_value''bar_value'] has-[button:hover]:bg-(--row-hover) @lg:min-h-10 @lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_5rem] @lg:[grid-template-areas:'name_bar_value']"
                key={row.key}
              >
                <div className="flex min-w-0 items-center gap-2.5 [grid-area:name]">
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
                <div aria-hidden="true" className="h-3 [grid-area:bar]">
                  <div className="flex h-full gap-0.5" style={{ width: `${width}%` }}>
                    {passed > 0 ? (
                      <span
                        className="h-full rounded-xs"
                        style={{
                          flex: passed,
                          ...hatch(row.other ? OTHER_MODEL_COLOR : SUCCEEDED_COLOR),
                        }}
                      />
                    ) : null}
                    {failed > 0 ? (
                      <span
                        className="h-full rounded-xs"
                        style={{ flex: failed, ...hatch(FAILED_COLOR) }}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="text-right tabular-nums leading-tight [grid-area:value]">
                  <div className="font-medium">
                    {metric === "credits"
                      ? formatCredits(row.totals.credits, 2, lang)
                      : formatNumber(row.totals.requests, lang)}
                  </div>
                  {metric === "credits" ? (
                    <div className="text-meta text-muted-foreground">
                      {t("usage.requestsCount", {
                        count: row.totals.requests,
                        n: formatNumber(row.totals.requests, lang),
                      })}
                    </div>
                  ) : row.totals.failed > 0 ? (
                    <div className="text-destructive-foreground text-meta">
                      {t("usage.failedCount", {
                        count: row.totals.failed,
                        n: formatNumber(row.totals.failed, lang),
                      })}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {onlyKeyless ? (
          <p className="text-muted-foreground text-sm">{t("usage.notTracked")}</p>
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

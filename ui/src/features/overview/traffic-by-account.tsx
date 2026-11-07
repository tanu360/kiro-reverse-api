import { ArrowUpRight01Icon, ChartColumnIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, lazy, Suspense, useMemo } from "react";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { heatmapQuery } from "@/lib/api/observe";
import type { HeatmapCell } from "@/lib/api/types";
import { formatNumber, formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { busyAccounts, HOUR, mergeCells, windowCells } from "./aggregate";
import { MODEL_COLORS, OTHER_MODEL_COLOR } from "./colors";
import { useTotalsFailed } from "./status-cards";
import type { AccountBucket, AccountSeries } from "./traffic-by-account-bars";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const TrafficByAccountBars = lazy(() => import("./traffic-by-account-bars"));

/** Accounts drawn as their own colour; the rest of the traffic is "Other accounts". */
const TOP_ACCOUNTS = 5;
/** Minutes per bar: 30 bars over the hour. */
const BUCKET_MINUTES = 2;

interface SeriesTotals {
  key: string;
  label: JSX.Element;
  text: string;
  color: string;
  requests: number;
  failures: number;
}

function totals(cells: readonly HeatmapCell[]): { requests: number; failures: number } {
  return cells.reduce(
    (sum, cell) => ({ requests: sum.requests + cell.reqs, failures: sum.failures + cell.failures }),
    { requests: 0, failures: 0 },
  );
}

/**
 * Traffic by account over the last hour: a stacked bar per two minutes, split by the five
 * busiest accounts (each its own colour) and the rest as "Other accounts", then a legend that
 * gives each account's requests and failures for the hour. The busiest come from the server
 * (`top`), ranked by requests plus failed attempts.
 */
export function TrafficByAccount(): JSX.Element {
  const { t, lang } = useT("overview");
  const display = useDisplayEmail();
  const reducedMotion = usePrefersReducedMotion();
  const query = useQuery(heatmapQuery(HOUR, { top: TOP_ACCOUNTS }));
  const totalsFailed = useTotalsFailed();
  const data = query.data;

  const view = useMemo(() => {
    if (!data) return null;
    const busiest = busyAccounts(data.accounts, HOUR, TOP_ACCOUNTS);
    const global = mergeCells(windowCells(data.global.cells, HOUR), BUCKET_MINUTES);
    const accounts = busiest.map((account, index) => ({
      key: `a${index}`,
      label: <DisplayEmail email={account.email} id={account.accountId} />,
      text: display(account.email, account.accountId),
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      buckets: mergeCells(windowCells(account.cells, HOUR), BUCKET_MINUTES),
    }));
    // Whatever the busiest accounts do not cover: never below zero (rounding between rows).
    const other = global.map((cell, index) => {
      const shown = accounts.reduce((sum, account) => sum + account.buckets[index].reqs, 0);
      const shownFailed = accounts.reduce(
        (sum, account) => sum + account.buckets[index].failures,
        0,
      );
      return {
        ...cell,
        reqs: Math.max(0, cell.reqs - shown),
        failures: Math.max(0, cell.failures - shownFailed),
      };
    });
    const otherSeries = {
      key: "other",
      label: <span>{t("heatmap.other")}</span>,
      text: t("heatmap.other"),
      color: OTHER_MODEL_COLOR,
      buckets: other,
    };
    const all = totals(other).requests > 0 ? [...accounts, otherSeries] : accounts;

    const rows: AccountBucket[] = global.map((cell, index) => {
      const start = data.nowUnix - (cell.offset + BUCKET_MINUTES - 1) * 60;
      const row: AccountBucket = {
        name: formatTime(start, lang),
        range: `${formatTime(start, lang)}–${formatTime(start + BUCKET_MINUTES * 60, lang)}`,
      };
      for (const series of all) {
        row[series.key] = series.buckets[index].reqs;
        row[`${series.key}Failed`] = series.buckets[index].failures;
      }
      return row;
    });
    // From the first bucket with traffic to now: an hour that only just got busy draws its few
    // bars in the middle of the plot (TrafficByAccountBars), not at its left edge.
    const firstBusy = rows.findIndex((row) => all.some((item) => Number(row[item.key]) > 0));
    const visibleRows = firstBusy > 0 ? rows.slice(firstBusy) : rows;
    const series: AccountSeries[] = all.map(({ key, text, color }) => ({
      key,
      label: text,
      color,
    }));
    const legend: SeriesTotals[] = all.map(({ key, label, text, color, buckets }) => ({
      key,
      label,
      text,
      color,
      ...totals(buckets),
    }));
    return {
      rows: visibleRows,
      slots: rows.length,
      series,
      legend,
      total: totals(global),
      shown: busiest.length,
      rest: Math.max(0, data.restCount ?? 0),
    };
  }, [data, t, display, lang]);

  const skeleton = (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <Skeleton className="aspect-2/1 w-full rounded-lg md:aspect-4/1" />
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
          <Skeleton className="h-4 w-full" key={index} />
        ))}
      </div>
    </div>
  );

  let body: JSX.Element;
  if (!view) {
    body = query.isError ? (
      totalsFailed ? (
        <ErrorState notLoaded />
      ) : (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("errors.heatmap")}
        />
      )
    ) : (
      skeleton
    );
  } else if (view.total.requests === 0) {
    body = (
      <EmptyState
        description={t("traffic.noTrafficBody")}
        icon={ChartColumnIcon}
        title={t("heatmap.empty")}
        variant="compact"
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {query.isError && !totalsFailed ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
            title={t("errors.heatmap")}
          />
        ) : null}
        <p className="sr-only">
          {t("heatmap.summary", {
            requests: t("heatmap.requests", {
              count: view.total.requests,
              n: formatNumber(view.total.requests, lang),
            }),
            errors: t("heatmap.errors", {
              count: view.total.failures,
              n: formatNumber(view.total.failures, lang),
            }),
          })}
        </p>
        <figure aria-label={t("heatmap.chartLabel")} className="min-w-0" role="img">
          <Suspense fallback={<Skeleton className="aspect-2/1 w-full rounded-lg md:aspect-4/1" />}>
            <TrafficByAccountBars
              data={view.rows}
              failedLabel={(count) => t("heatmap.failed", { count, n: formatNumber(count, lang) })}
              formatCount={(value) => formatNumber(value, lang)}
              reducedMotion={reducedMotion}
              series={view.series}
              slots={view.slots}
            />
          </Suspense>
        </figure>
        {/* The legend is the readable version of the chart: each account's hour in numbers. */}
        <ul
          aria-label={t("heatmap.legendLabel")}
          className="grid grid-cols-1 gap-x-8 gap-y-2 @md:grid-cols-2 @3xl:grid-cols-3"
        >
          {view.legend.map((item) => (
            <li className="flex min-w-0 items-center gap-2 text-sm" key={item.key}>
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatNumber(item.requests, lang)}
              </span>
              {item.failures > 0 ? (
                <span className="shrink-0 text-destructive-foreground text-meta tabular-nums">
                  {t("heatmap.failed", {
                    count: item.failures,
                    n: formatNumber(item.failures, lang),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <SectionCard
      actions={
        <Button
          aria-label={t("heatmap.viewAllLabel")}
          render={<Link to="/accounts" />}
          size="sm"
          variant="ghost"
        >
          {t("heatmap.viewAll")}
          <HugeiconsIcon icon={ArrowUpRight01Icon} aria-hidden="true" />
        </Button>
      }
      description={
        view && view.rest > 0
          ? t("heatmap.descriptionTop", {
              shown: formatNumber(view.shown, lang),
              total: formatNumber(view.shown + view.rest, lang),
            })
          : t("heatmap.description")
      }
      descriptionVariant="inline"
      icon={ChartColumnIcon}
      id="overview-heatmap"
      title={t("heatmap.title")}
    >
      {body}
    </SectionCard>
  );
}

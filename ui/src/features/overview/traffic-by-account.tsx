import { ChartColumnIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type JSX, type ReactNode, useMemo, useState } from "react";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { accountsQuery } from "@/lib/api/accounts";
import { heatmapQuery } from "@/lib/api/observe";
import type { Account, HeatmapCell } from "@/lib/api/types";
import { formatCredits, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { placeholderKeys } from "@/lib/utils";
import { AuthIcon } from "../accounts/account-cells";
import { busyAccounts, HOUR } from "./aggregate";
import { FAILED_COLOR, OTHER_MODEL_COLOR, SUCCEEDED_COLOR } from "./colors";
import { useTotalsFailed } from "./totals";

/** Accounts listed by name; the rest of the traffic is one "N other accounts" row. */
const TOP_ACCOUNTS = 5;
/** A full list's rows while loading: the top accounts and the others. */
const ROW_PLACEHOLDERS = placeholderKeys("row", TOP_ACCOUNTS + 1);

type Metric = "requests" | "credits";
const METRICS: readonly Metric[] = ["requests", "credits"];

function isMetric(value: unknown): value is Metric {
  return typeof value === "string" && (METRICS as readonly string[]).includes(value);
}

interface Totals {
  requests: number;
  failures: number;
  credits: number;
}

const NONE: Totals = { requests: 0, failures: 0, credits: 0 };

/** The last hour of one heatmap row: offsets 0-59. */
function hourTotals(cells: readonly HeatmapCell[]): Totals {
  return cells
    .filter((cell) => cell.offset >= 0 && cell.offset < HOUR)
    .reduce(
      (sum, cell) => ({
        requests: sum.requests + cell.reqs,
        failures: sum.failures + cell.failures,
        credits: sum.credits + (cell.credits ?? 0),
      }),
      NONE,
    );
}

/** The row's amount in the chosen measure. */
function amountOf(totals: Totals, metric: Metric): number {
  return metric === "credits" ? totals.credits : totals.requests;
}

/** Diagonal hatching in one series colour, as the traffic bars: a 30 % wash, a 3 px stripe. */
function hatch(color: string): CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in oklab, ${color} 30%, var(--card)) 3px 6px)`,
  };
}

interface Row {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  other: boolean;
  totals: Totals;
}

/**
 * Traffic by account over the last hour: the five busiest accounts (the server's `top`, ranked
 * by requests plus failed attempts) as hatched bars, failures in red at the end of each, and the
 * rest of the traffic as one lighter row. Requests or credits, picked in the header.
 */
export function TrafficByAccount(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(heatmapQuery(HOUR, { top: TOP_ACCOUNTS }));
  // The sign-in marks come from the account list the Accounts page shares (same key).
  const accounts = useQuery(accountsQuery());
  const totalsFailed = useTotalsFailed();
  const [metric, setMetric] = useState<Metric>("requests");
  const data = query.data;

  const byId = useMemo(
    () => new Map<string, Account>((accounts.data ?? []).map((account) => [account.id, account])),
    [accounts.data],
  );

  const view = useMemo(() => {
    if (!data) return null;
    const busiest = busyAccounts(data.accounts ?? [], HOUR, TOP_ACCOUNTS).map((account) => ({
      account,
      totals: hourTotals(account.cells),
    }));
    const total = hourTotals(data.global.cells);
    const shown = busiest.reduce(
      (sum, row) => ({
        requests: sum.requests + row.totals.requests,
        failures: sum.failures + row.totals.failures,
        credits: sum.credits + row.totals.credits,
      }),
      NONE,
    );
    // Whatever the busiest accounts do not cover: never below zero (rounding between rows).
    const other: Totals = {
      requests: Math.max(0, total.requests - shown.requests),
      failures: Math.max(0, total.failures - shown.failures),
      credits: Math.max(0, total.credits - shown.credits),
    };
    return {
      busiest,
      other,
      total,
      shown: busiest.length,
      rest: Math.max(0, data.restCount ?? 0),
    };
  }, [data]);

  const rows = useMemo((): Row[] => {
    if (!view) return [];
    const named: Row[] = view.busiest
      .map(({ account, totals }) => {
        const known = byId.get(account.accountId);
        return {
          key: account.accountId,
          icon: known ? <AuthIcon account={known} /> : null,
          label: <DisplayEmail email={account.email} id={account.accountId} />,
          other: false,
          totals,
        };
      })
      .sort((a, b) => amountOf(b.totals, metric) - amountOf(a.totals, metric));
    if (view.other.requests === 0 && view.other.credits === 0) return named;
    const otherCount = view.rest;
    return [
      ...named,
      {
        key: "other",
        icon: (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
            icon={UserMultipleIcon}
          />
        ),
        // With every busy account listed, the rest never reached an account (a wrong key, an
        // unknown model, no account free); "Other accounts" read as if accounts were missing.
        label:
          otherCount > 0
            ? t("heatmap.otherCount", { count: otherCount, n: formatNumber(otherCount, lang) })
            : t("heatmap.noAccount"),
        other: true,
        totals: view.other,
      },
    ];
  }, [view, byId, metric, t, lang]);

  // The busiest named account fills the track; the others row is capped at full width.
  const scale = Math.max(
    1e-9,
    ...rows.filter((row) => !row.other).map((row) => amountOf(row.totals, metric)),
    0,
  );

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
      <div className="flex flex-col gap-3">
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
        {/*
          Each row: the account, its bar and its numbers. A phone puts the name and numbers on
          one line and the bar under the name; a wider card lays the three side by side.
        */}
        <ul aria-label={t("heatmap.legendLabel")} className="flex flex-col gap-4 @lg:gap-3">
          {rows.map((row) => {
            const amount = amountOf(row.totals, metric);
            const width = Math.min(100, (amount / scale) * 100);
            // Credits have no failed part; requests end in their failures.
            const failed = metric === "requests" ? row.totals.failures : 0;
            const passed = Math.max(0, amount - failed);
            return (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 text-sm [grid-template-areas:'name_value''bar_value'] @lg:min-h-10 @lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_5rem] @lg:[grid-template-areas:'name_bar_value']"
                key={row.key}
              >
                <div
                  className={
                    row.other
                      ? "flex min-w-0 items-center gap-2.5 text-muted-foreground [grid-area:name]"
                      : "flex min-w-0 items-center gap-2.5 [grid-area:name]"
                  }
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {row.icon}
                  </span>
                  <span className="min-w-0 truncate">{row.label}</span>
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
                      {t("heatmap.requests", {
                        count: row.totals.requests,
                        n: formatNumber(row.totals.requests, lang),
                      })}
                    </div>
                  ) : row.totals.failures > 0 ? (
                    <div className="text-destructive-foreground text-meta">
                      {t("heatmap.failed", {
                        count: row.totals.failures,
                        n: formatNumber(row.totals.failures, lang),
                      })}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <SectionCard
      actions={
        // A radio group: one tab stop, the arrow keys switch the measure.
        <SegmentedControl
          render={
            <RadioGroupPrimitive
              aria-label={t("heatmap.metric")}
              onValueChange={(next) => {
                if (isMetric(next)) setMetric(next);
              }}
              value={metric}
            />
          }
          size="sm"
        >
          {METRICS.map((item) => (
            <SegmentedControlItem key={item} render={<RadioPrimitive.Root value={item} />}>
              {t(`modelMix.${item}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
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

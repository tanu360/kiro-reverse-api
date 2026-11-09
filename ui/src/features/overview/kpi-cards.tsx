import {
  AlertCircleIcon,
  ArrowUpRight01Icon,
  CoinsDollarIcon,
  Route01Icon,
  UsersIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { type JSX, type ReactNode, useMemo } from "react";
import { formatDelta } from "@/components/shared/stat-card";
import { Card, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { accountsQuery } from "@/lib/api/accounts";
import { heatmapQuery, observeOverviewQuery } from "@/lib/api/observe";
import { statusQuery } from "@/lib/api/system";
import type { Account, HeatmapCell } from "@/lib/api/types";
import { EMPTY, formatCompact, formatCredits, formatNumber, formatPercent } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { accountStatus } from "../accounts/account-model";
import { bucketGlobal, type CellValue, HOUR, HOUR_PAIR_WINDOW, hourDelta } from "./aggregate";
import { LazySparkline, TrendPlaceholder } from "./lazy-sparkline";

const requests: CellValue = (cell) => cell.reqs;
const failures: CellValue = (cell) => cell.failures;

/** The requests sparkline: 2-minute buckets over the last hour (30 points). */
const SPARK_BUCKET_MIN = 2;
/** The failed pills: 4-minute buckets over the last hour (15 pills). */
const PILL_BUCKET_MIN = 4;
const SPARK_HEIGHT = 52;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

interface Part {
  key: string;
  label: string;
  /** Formatted value shown in the legend. */
  shown: string;
  /** Share of the bar. */
  value: number;
  /** Background class for the bar segment and the legend dot (a theme token). */
  tone: string;
}

/** A row of rounded segments, each as wide as its share; an empty pool is one grey track. */
function SegmentBar({ parts }: { parts: readonly Part[] }): JSX.Element {
  const visible = parts.filter((part) => part.value > 0);
  return (
    <div aria-hidden="true" className="mt-3.5 flex h-1.5 gap-0.75" data-slot="kpi-bar">
      {visible.length === 0 ? (
        <span className="flex-1 rounded-full bg-border" />
      ) : (
        visible.map((part) => (
          <span
            className={cn("min-w-1.5 rounded-full", part.tone)}
            key={part.key}
            // A share is data, so it stays an inline style.
            style={{ flexGrow: part.value, flexBasis: 0 }}
          />
        ))
      )}
    </div>
  );
}

/** The bar's key: a dot, the label and the value, two to a row. */
function PartLegend({ parts }: { parts: readonly Part[] }): JSX.Element {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-meta" data-slot="kpi-legend">
      {parts.map((part) => (
        <div className="flex min-w-0 items-center gap-2" key={part.key}>
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", part.tone)} />
          <dt className="min-w-0 truncate text-muted-foreground">{part.label}</dt>
          <dd className="ms-auto font-medium tabular-nums">{part.shown}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "+107.1%" in green or red (by which way is good), then a muted comparison. */
function Delta({
  value,
  goodWhen,
  label,
  lang,
}: {
  value: number;
  goodWhen: "up" | "down";
  label: string;
  lang: Lang;
}): JSX.Element {
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const tone = direction === "flat" ? "neutral" : direction === goodWhen ? "good" : "bad";
  return (
    <span data-slot="kpi-delta" data-tone={tone}>
      <span
        className={cn(
          "font-medium tabular-nums",
          tone === "good" && "text-success-foreground",
          tone === "bad" && "text-destructive-foreground",
          tone === "neutral" && "text-foreground",
        )}
      >
        {formatDelta(value, lang)}
      </span>{" "}
      {label}
    </span>
  );
}

/** Pills over the last hour, tallest for the bucket with the most failures; the newest is solid. */
function FailurePills({ values }: { values: readonly number[] }): JSX.Element {
  const peak = Math.max(0, ...values);
  return (
    <div aria-hidden="true" className="mt-3.5 flex h-13 gap-1" data-slot="kpi-pills">
      {values.map((value, index) => {
        const last = index === values.length - 1;
        const share = peak > 0 && value > 0 ? Math.max(0.14, value / peak) : 0;
        return (
          <span
            className="relative flex-1 overflow-hidden rounded-full bg-error-surface"
            // Buckets have no id; their position in the hour is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length, position-keyed buckets
            key={index}
          >
            <span
              className={cn(
                "absolute inset-x-0 bottom-0 rounded-full",
                last ? "bg-destructive" : "bg-destructive/45",
              )}
              style={{ height: `${share * 100}%` }}
            />
          </span>
        );
      })}
    </div>
  );
}

/**
 * One KPI card: icon and label with its period on the right, the figure, a muted line (often a
 * delta), a visual, and a footer link to the page behind the number.
 */
function KpiCard({
  icon,
  label,
  period,
  value,
  suffix,
  sub,
  visual,
  link,
  linkLabel,
  loading = false,
}: {
  icon: IconSvgElement;
  label: string;
  period: string;
  value: ReactNode;
  suffix?: ReactNode;
  sub?: ReactNode;
  visual?: ReactNode;
  link: LinkProps;
  linkLabel: string;
  loading?: boolean;
}): JSX.Element {
  return (
    <Card className="min-w-0" data-slot="kpi-card">
      <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
        <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <HugeiconsIcon aria-hidden="true" className="size-4 shrink-0" icon={icon} />
          <span className="min-w-0 truncate">{label}</span>
          <span className="ms-auto shrink-0 text-xs">{period}</span>
        </div>
        {loading ? (
          <div aria-hidden="true" className="flex flex-col">
            <Skeleton className="mt-2.5 h-7 w-24" />
            <Skeleton className="mt-2 h-4 w-40" />
            <Skeleton className="mt-3.5 h-13 w-full" />
          </div>
        ) : (
          <>
            <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold text-foreground text-kpi leading-8 tabular-nums">
                {value}
              </span>
              {suffix ? (
                <span className="text-meta text-muted-foreground tabular-nums">{suffix}</span>
              ) : null}
            </div>
            {sub ? <p className="min-h-5 text-meta text-muted-foreground">{sub}</p> : null}
            {visual}
          </>
        )}
      </div>
      <CardFooter className="p-0 sm:p-0">
        <Link
          {...link}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 px-4 py-2.5 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline sm:px-5"
        >
          <span className="min-w-0 truncate">{linkLabel}</span>
          <HugeiconsIcon aria-hidden="true" className="size-4 shrink-0" icon={ArrowUpRight01Icon} />
        </Link>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type HealthKey = "available" | "attention" | "banned" | "disabled";

/** Accounts per health group: banned and suspended apart from the other problems. */
function healthCounts(accounts: readonly Account[], nowSec: number): Record<HealthKey, number> {
  const counts: Record<HealthKey, number> = { available: 0, attention: 0, banned: 0, disabled: 0 };
  for (const account of accounts) {
    const status = accountStatus(account, nowSec);
    if (status === "active") counts.available += 1;
    else if (status === "disabled") counts.disabled += 1;
    else if (status === "banned" || status === "suspended") counts.banned += 1;
    else counts.attention += 1;
  }
  return counts;
}

/** The current hour's cells (offsets 0-59) as oldest-first buckets. */
function hourBuckets(
  cells: readonly HeatmapCell[],
  nowUnix: number,
  bucketMin: number,
  value: (point: { succeeded: number; failed: number }) => number,
): number[] {
  return bucketGlobal(cells, nowUnix, bucketMin, HOUR).map(value);
}

function bannedToday(count: number, t: TFunction): ReactNode {
  if (count <= 0) return t("kpi.noneBannedToday");
  return <span className="text-destructive-foreground">{t("kpi.bannedToday", { count })}</span>;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * The Overview's four KPI cards: account health now, plan credits this month, and requests and
 * failures over the last hour against the hour before. Each card links to the page behind its
 * number. A /status failure shows dashes; the page banner carries the error and its Retry.
 */
export function KpiCards(): JSX.Element {
  const { t, lang } = useT("overview");
  const animate = !usePrefersReducedMotion();
  const status = useQuery(statusQuery());
  // The two-hour global heatmap the traffic card's 1 h view reads too (same key).
  const heatmap = useQuery(heatmapQuery(HOUR_PAIR_WINDOW, { scope: "global" }));
  const live = useQuery(observeOverviewQuery());
  const accounts = useQuery(accountsQuery());

  const s = status.data;
  const cells = heatmap.data?.global.cells;
  const nowUnix = heatmap.data?.nowUnix;

  const health = useMemo(
    () => (accounts.data ? healthCounts(accounts.data, Date.now() / 1000) : null),
    [accounts.data],
  );
  const hour = useMemo(() => {
    if (!cells || nowUnix === undefined) return null;
    return {
      requests: hourDelta(cells, requests),
      failures: hourDelta(cells, failures),
      spark: hourBuckets(cells, nowUnix, SPARK_BUCKET_MIN, (p) => p.succeeded + p.failed).map(
        (value) => ({ value }),
      ),
      pills: hourBuckets(cells, nowUnix, PILL_BUCKET_MIN, (p) => p.failed),
    };
  }, [cells, nowUnix]);

  const vsLastHour = t("stats.vsLastHour");
  const statusLoading = !s && !status.isError;
  const hourLoading = !hour && !heatmap.isError;

  // 1. Accounts: the list's health groups, or /status totals until the list arrives.
  const total = accounts.data?.length ?? s?.accounts;
  const available = health?.available ?? s?.available;
  const healthParts: Part[] = health
    ? [
        {
          key: "available",
          label: t("kpi.available"),
          shown: formatNumber(health.available, lang),
          value: health.available,
          tone: "bg-success",
        },
        {
          key: "attention",
          label: t("kpi.attention"),
          shown: formatNumber(health.attention, lang),
          value: health.attention,
          tone: "bg-warning",
        },
        {
          key: "banned",
          label: t("kpi.banned"),
          shown: formatNumber(health.banned, lang),
          value: health.banned,
          tone: "bg-destructive",
        },
        {
          key: "disabled",
          label: t("kpi.disabled"),
          shown: formatNumber(health.disabled, lang),
          value: health.disabled,
          tone: "bg-border-strong",
        },
      ]
    : [];

  // 2. Plan credits: proxy and outside-proxy use against the summed plan limits.
  const used = s?.accountCreditsUsed ?? 0;
  const limit = s?.accountCreditsLimit ?? 0;
  const proxy = Math.min(s?.totalCredits ?? 0, used);
  const outside = Math.max(0, used - (s?.totalCredits ?? 0));
  const remaining = Math.max(0, limit - used);
  const creditParts: Part[] = [
    {
      key: "proxy",
      label: t("kpi.proxy"),
      shown: formatCompact(proxy, lang),
      value: proxy,
      tone: "bg-primary",
    },
    {
      key: "outside",
      label: t("kpi.outside"),
      shown: formatCompact(outside, lang),
      value: outside,
      tone: "bg-(--chart-other)",
    },
    {
      key: "remaining",
      label: t("kpi.remaining"),
      shown: formatCompact(remaining, lang),
      value: remaining,
      tone: "bg-border-strong",
    },
  ];
  const liveAccounts: Part = {
    key: "live",
    label: t("kpi.liveNow"),
    shown: live.data ? formatNumber(live.data.activeAccts, lang) : EMPTY,
    value: 0,
    tone: "bg-success",
  };

  // 3 and 4. The last hour against the one before.
  const current = hour?.requests.current ?? 0;
  const failed = hour?.failures.current ?? 0;

  return (
    <section
      aria-busy={statusLoading || hourLoading ? true : undefined}
      aria-label={t("kpi.label")}
      className="grid min-w-0 grid-cols-1 gap-4 @3xl/main:grid-cols-2 @5xl/main:grid-cols-4"
      data-slot="kpi-cards"
    >
      <KpiCard
        icon={UsersIcon}
        label={t("kpi.accounts")}
        link={{ to: "/accounts", search: { status: "attention" } }}
        linkLabel={t("kpi.reviewAttention")}
        loading={statusLoading && !accounts.data}
        period={t("kpi.now")}
        sub={s ? bannedToday(s.todayBanned, t) : null}
        suffix={
          total === undefined ? null : t("kpi.availableOf", { total: formatNumber(total, lang) })
        }
        value={available === undefined ? EMPTY : formatNumber(available, lang)}
        visual={
          health ? (
            <>
              <SegmentBar parts={healthParts} />
              <PartLegend parts={healthParts} />
            </>
          ) : accounts.isPending ? (
            <Skeleton aria-hidden="true" className="mt-3.5 h-13 w-full" />
          ) : null
        }
      />
      <KpiCard
        icon={CoinsDollarIcon}
        label={t("kpi.planCredits")}
        link={{ to: "/accounts" }}
        linkLabel={t("kpi.viewAccounts")}
        loading={statusLoading}
        period={t("kpi.thisMonth")}
        sub={
          s && limit > 0
            ? `${formatCredits(used, 1, lang)} / ${formatCredits(limit, 1, lang)}`
            : null
        }
        suffix={s && limit > 0 ? t("kpi.used") : null}
        value={s && limit > 0 ? formatPercent(used, limit, lang) : EMPTY}
        visual={
          s ? (
            <>
              <SegmentBar parts={creditParts} />
              <PartLegend parts={[...creditParts, liveAccounts]} />
            </>
          ) : null
        }
      />
      <KpiCard
        icon={Route01Icon}
        label={t("kpi.requests")}
        link={{ to: "/requests" }}
        linkLabel={t("kpi.viewRequests")}
        loading={hourLoading}
        period={t("kpi.lastHour")}
        sub={
          hour ? (
            hour.requests.delta === null ? (
              t("kpi.noPreviousHour")
            ) : (
              <Delta goodWhen="up" label={vsLastHour} lang={lang} value={hour.requests.delta} />
            )
          ) : null
        }
        value={hour ? formatNumber(current, lang) : EMPTY}
        visual={
          hour ? (
            <div aria-hidden="true" className="mt-3.5" style={{ height: SPARK_HEIGHT }}>
              <LazySparkline animate={animate} data={hour.spark} height={SPARK_HEIGHT} />
            </div>
          ) : heatmap.isError ? null : (
            <div className="mt-3.5" style={{ height: SPARK_HEIGHT }}>
              <TrendPlaceholder />
            </div>
          )
        }
      />
      <KpiCard
        icon={AlertCircleIcon}
        label={t("kpi.failed")}
        link={{ to: "/requests", search: { status: "failed" } }}
        linkLabel={t("kpi.viewFailed")}
        loading={hourLoading}
        period={t("kpi.lastHour")}
        sub={
          hour ? (
            hour.failures.delta === null ? (
              t("kpi.noPreviousHour")
            ) : (
              <Delta goodWhen="down" label={vsLastHour} lang={lang} value={hour.failures.delta} />
            )
          ) : null
        }
        suffix={
          hour && current > 0
            ? t("kpi.failureRate", { value: formatPercent(failed, current, lang) })
            : null
        }
        value={hour ? formatNumber(failed, lang) : EMPTY}
        visual={hour ? <FailurePills values={hour.pills} /> : null}
      />
    </section>
  );
}

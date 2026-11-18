import {
  AlertCircleIcon,
  CoinsDollarIcon,
  Infinity01Icon,
  Route01Icon,
  TokenCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { CardFooter } from "@/components/ui/card";
import { Meter, MeterIndicator, type MeterTone, MeterTrack } from "@/components/ui/meter";
import { Skeleton } from "@/components/ui/skeleton";
import { limitTone } from "@/features/api/api-key-form";
import { MODEL_COLORS } from "@/features/overview/colors";
import {
  Delta,
  FailurePills,
  KPI_GRID_CLASS,
  KpiCard,
  KpiSparkline,
  type Part,
  SegmentBar,
} from "@/features/overview/kpi-cards";
import type { ApiKeyUsageEntry, ApiKeyUsageTotals } from "@/lib/api/api-key-usage";
import type { UserKey, UserUsage, UserUsageRange } from "@/lib/api/user-panel";
import {
  EMPTY,
  formatCompact,
  formatCredits,
  formatFraction,
  formatNumber,
  formatPercent,
  numberFormat,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Metric = "requests" | "failed" | "credits" | "tokens";

/** A limit used past this share turns amber; a spent one red (as the admin's limits card). */

/** Each trend's colour: requests in the series purple, credits teal, tokens blue. */
const TREND_COLOR: Partial<Record<Metric, string>> = {
  credits: MODEL_COLORS[3],
  tokens: MODEL_COLORS[2],
};

/** At most this many failure pills: longer series are summed in runs, newest run last. */
const MAX_PILLS = 24;

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function formatMetric(metric: Metric, value: number, lang: Lang): string {
  if (metric === "credits") return formatCredits(value, 2, lang);
  if (metric === "tokens") return formatCompact(value, lang);
  return formatNumber(value, lang);
}

/**
 * Sums `values` in runs of equal length, counted from the newest, so a long range still fits
 * MAX_PILLS pills and the last pill is the latest stretch.
 */
export function pillValues(values: readonly number[], max = MAX_PILLS): number[] {
  if (values.length <= max) return [...values];
  const run = Math.ceil(values.length / max);
  const pills: number[] = [];
  for (let end = values.length; end > 0; end -= run) {
    pills.unshift(values.slice(Math.max(0, end - run), end).reduce((sum, v) => sum + v, 0));
  }
  return pills;
}

/**
 * The muted line under a figure: the change against the stretch before the range (the
 * Overview's delta), or why there is none.
 */
function Comparison({
  metric,
  range,
  totals,
  previous,
  neverUsed,
}: {
  metric: Metric;
  range: UserUsageRange;
  totals: ApiKeyUsageTotals;
  previous: ApiKeyUsageTotals | undefined;
  neverUsed: boolean;
}): ReactNode {
  const { t, lang } = useT("user-panel");
  const now = totals[metric];
  const before = previous?.[metric] ?? 0;
  if (range !== "all" && previous && before > 0) {
    return (
      <Delta
        goodWhen={metric === "failed" ? "down" : "up"}
        lang={lang}
        // Left as a template: Delta fills its {delta} with the coloured change.
        template={t(`kpi.vs.${range}`)}
        value={(now - before) / before}
      />
    );
  }
  if (metric === "failed" && now === 0) return t("kpi.nothingFailed");
  if (totals.requests === 0 && (previous?.requests ?? 0) === 0 && neverUsed) {
    return t("kpi.noRequests");
  }
  if (range === "all") return t("kpi.lifetime");
  if (!previous) return null;
  return previous.requests === 0 ? t(`kpi.noneBefore.${range}`) : t(`kpi.zeroBefore.${range}`);
}

/** The card's trend, or a flat dashed floor when the measure stayed at zero. */
function Trend({
  data,
  color,
  idle,
}: {
  data: readonly { value: number }[];
  color?: string;
  /** No requests at all in the range: the floor says so. */
  idle: boolean;
}): JSX.Element {
  const { t } = useT("user-panel");
  if (data.every((point) => point.value === 0)) {
    return (
      <div
        aria-hidden="true"
        className="relative mt-3.5 flex h-13 min-w-0 items-end"
        data-slot="kpi-trend-empty"
      >
        <div className="w-full border-border-strong border-t border-dashed" />
        {idle ? (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-meta text-muted-foreground">
            {t("kpi.noTraffic")}
          </span>
        ) : null}
      </div>
    );
  }
  // A lifetime of one bucket still draws a line.
  return <KpiSparkline color={color} data={data.length === 1 ? [data[0], data[0]] : data} />;
}

// ---------------------------------------------------------------------------
// Footers
// ---------------------------------------------------------------------------

type LimitKind = "calls" | "credits" | "tokens";

const FOOTER_CLASS = "min-h-11 flex-col flex-nowrap items-stretch gap-2 py-4";

function FooterSkeleton(): JSX.Element {
  return (
    <CardFooter aria-hidden="true" className={FOOTER_CLASS}>
      <Skeleton className="h-1.5 w-full" />
      <Skeleton className="h-4 w-32" />
    </CardFooter>
  );
}

/**
 * A limit's share: whole percents from 10%, one decimal under it, and "<0.1%" for a sliver. One
 * with some left never reads 100% (99.7% shows 99%); a spent one shows its real share (104%).
 */
export function limitShare(share: number, reached: boolean, lang: Lang): string {
  const percent = (fraction: number, digits: number) =>
    numberFormat(lang, { style: "percent", maximumFractionDigits: digits }).format(fraction);
  if (reached) return percent(share, 0);
  if (share > 0 && share < 0.0005) return `<${percent(0.001, 1)}`;
  const digits = share < 0.1 ? 1 : 0;
  const step = 10 ** (digits + 2);
  return percent(Math.min(Math.round(share * step) / step, 0.99), digits);
}

/**
 * The key's own limit for a card's measure, counted since the key was created: a meter in the
 * limit's tone (amber from 75%, red once spent), "used of limit" and the share; or the same
 * meter's empty track (so every footer lines up), what was used and "No key limit".
 */
function LimitFooter({ apiKey, kind }: { apiKey: UserKey | undefined; kind: LimitKind }) {
  const { t, lang } = useT("user-panel");
  const { t: ta } = useT("api");
  if (!apiKey) return <FooterSkeleton />;
  const [used, limit] =
    kind === "calls"
      ? [apiKey.successfulCalls, apiKey.callLimit]
      : kind === "credits"
        ? [apiKey.creditsUsed, apiKey.creditLimit]
        : [apiKey.tokensUsed, apiKey.tokenLimit];
  const full = (value: number) =>
    kind === "credits" ? formatCredits(value, 2, lang) : formatNumber(value, lang);
  const short = (value: number) =>
    kind === "credits" ? formatCredits(value, 2, lang) : formatCompact(value, lang);
  if (limit <= 0) {
    return (
      <CardFooter className={FOOTER_CLASS} data-limit="none">
        {/* Decorative: "No key limit" below says it. */}
        <Meter aria-hidden="true" max={1} min={0} value={0}>
          <MeterTrack className="h-1.5">
            <MeterIndicator />
          </MeterTrack>
        </Meter>
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 tabular-nums">
            {t("kpi.usedSinceCreated", { n: short(used) })}
          </span>
          {/* The words carry the baseline, the sign is centred on them: led by an items-center icon,
              the span's baseline was the icon's bottom edge and the words rose 3 px. */}
          <span className="inline-flex shrink-0 items-baseline gap-1.5">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-3.5 self-center"
              icon={Infinity01Icon}
              strokeWidth={2}
            />
            {t("kpi.noLimit")}
          </span>
        </div>
      </CardFooter>
    );
  }
  const reached = used >= limit;
  const share = used / limit;
  const tone: MeterTone = limitTone(used, limit);
  // The short forms, unless they would read the same ("2M of 2M" with some left).
  const exact = used !== limit && short(used) === short(limit);
  const shown = (value: number) => (exact ? full(value) : short(value));
  return (
    <CardFooter className={FOOTER_CLASS} data-limit={tone}>
      <Meter
        aria-label={ta(`keys.${kind}Usage`, { used: full(used), limit: full(limit) })}
        max={limit}
        min={0}
        value={Math.min(used, limit)}
      >
        <MeterTrack className="h-1.5">
          <MeterIndicator tone={tone} />
        </MeterTrack>
      </Meter>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="tabular-nums">
          {t("kpi.ofLimit", { used: shown(used), limit: shown(limit) })}
        </span>
        <span
          className={cn(
            "font-medium tabular-nums",
            tone === "default" && "text-foreground",
            tone === "warning" && "text-warning-foreground",
            tone === "destructive" && "text-destructive-foreground",
          )}
        >
          {reached
            ? t("kpi.limitReached", { share: limitShare(share, true, lang) })
            : t("kpi.shareOfLimit", { share: limitShare(share, false, lang) })}
        </span>
      </div>
    </CardFooter>
  );
}

/** The Failed card's footer: succeeded beside failed on one bar, and the success rate. */
function OutcomeFooter({
  totals,
  loading,
}: {
  totals: ApiKeyUsageTotals | undefined;
  loading: boolean;
}): JSX.Element {
  const { t, lang } = useT("user-panel");
  if (loading) return <FooterSkeleton />;
  const parts: Part[] = totals
    ? [
        {
          key: "succeeded",
          label: t("kpi.succeeded", { n: formatNumber(totals.succeeded, lang) }),
          shown: formatNumber(totals.succeeded, lang),
          value: totals.succeeded,
          tone: "bg-success",
        },
        {
          key: "failed",
          label: t("kpi.failed"),
          shown: formatNumber(totals.failed, lang),
          value: totals.failed,
          tone: "bg-destructive",
        },
      ]
    : [];
  return (
    <CardFooter className={FOOTER_CLASS}>
      <SegmentBar className="mt-0" parts={parts} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="tabular-nums">
          {totals ? t("kpi.succeeded", { n: formatNumber(totals.succeeded, lang) }) : EMPTY}
        </span>
        {totals?.requests ? (
          <span className="font-medium text-foreground tabular-nums">
            {t("kpi.successRate", {
              rate: formatFraction(totals.succeeded / totals.requests, 1, lang),
            })}
          </span>
        ) : null}
      </div>
    </CardFooter>
  );
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * The key's usage for the range as the Overview's KPI cards: requests, failed, credits and
 * tokens, each with the change against the stretch before the range (the server's `previous`)
 * and its trend, and in the footer the key's own limit for that measure. The figures stay bars
 * until the range loads; a failed load shows dashes (the chart card below has the error).
 */
export function UsageKpis({
  apiKey,
  range,
  usage,
  entry,
  isError,
}: {
  apiKey: UserKey | undefined;
  range: UserUsageRange;
  usage: UserUsage | undefined;
  /** This key's row of `usage`. */
  entry: ApiKeyUsageEntry | undefined;
  isError: boolean;
}): JSX.Element {
  const { t, lang } = useT("user-panel");
  const { t: tc } = useT();
  const totals = entry?.totals ?? usage?.totals;
  const loading = !usage && !isError;
  const series = entry?.series ?? [];
  const period = t(`usage.period.${range}`);
  const idle = !totals?.requests;

  const card = (metric: Metric) => {
    if (!totals) {
      return {
        loading,
        value: EMPTY,
        sub: isError ? tc("state.notLoaded") : null,
        visual: null,
      };
    }
    return {
      loading,
      value: formatMetric(metric, totals[metric], lang),
      sub: (
        <Comparison
          metric={metric}
          neverUsed={!apiKey?.lastUsedAt}
          previous={usage?.previous}
          range={range}
          totals={totals}
        />
      ),
      visual:
        metric === "failed" ? (
          // A week's seven pills stay as thin as a day's 24, spread over the card.
          <FailurePills
            className="justify-between *:max-w-3"
            values={pillValues(series.map((point) => point.failed))}
          />
        ) : (
          <Trend
            color={TREND_COLOR[metric]}
            data={series.map((point) => ({ value: point[metric] }))}
            idle={idle}
          />
        ),
    };
  };

  return (
    <div aria-busy={loading ? true : undefined} className={KPI_GRID_CLASS} data-slot="usage-kpis">
      <KpiCard
        {...card("requests")}
        footer={<LimitFooter apiKey={apiKey} kind="calls" />}
        icon={Route01Icon}
        label={t("kpi.requests")}
        period={period}
      />
      <KpiCard
        {...card("failed")}
        footer={<OutcomeFooter loading={loading} totals={totals} />}
        icon={AlertCircleIcon}
        label={t("kpi.failed")}
        period={period}
        suffix={
          totals?.requests
            ? t("kpi.failureRate", { value: formatPercent(totals.failed, totals.requests, lang) })
            : null
        }
      />
      <KpiCard
        {...card("credits")}
        footer={<LimitFooter apiKey={apiKey} kind="credits" />}
        icon={CoinsDollarIcon}
        label={t("kpi.credits")}
        period={period}
      />
      <KpiCard
        {...card("tokens")}
        footer={<LimitFooter apiKey={apiKey} kind="tokens" />}
        icon={TokenCircleIcon}
        label={t("kpi.tokens")}
        period={period}
        suffix={
          totals?.tokens
            ? t("kpi.tokenSplit", {
                in: formatCompact(totals.inTokens, lang),
                out: formatCompact(totals.outTokens, lang),
              })
            : null
        }
      />
    </div>
  );
}

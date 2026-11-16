import {
  ArrowRight02Icon,
  Cancel01Icon,
  DatabaseAddIcon,
  DatabaseIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { CreditAmount } from "@/components/shared/credit-amount";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestRecord } from "@/lib/api/types";
import {
  belowStep,
  EMPTY,
  formatCompact,
  formatDecimal,
  formatDurationMs,
  formatFraction,
  formatNumber,
  formatTime,
  roundsToZero,
  unixToDate,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { requestProxyText } from "./proxy-failure";
import {
  type ErrorTone,
  errorTypeTone,
  formatRowDate,
  isKnownErrorType,
  requestTries,
} from "./request-model";

/*
 * The pieces of a Requests row, shared by the table cells and the narrow-layout row: the status
 * node on the time rail, the token bar, the credits, duration and speed chips, the cache hit, the
 * HTTP status with its tries, the request ID and the error pill.
 */

export function Muted({ children = EMPTY }: { children?: string }): JSX.Element {
  return <span className="text-muted-foreground">{children}</span>;
}

/** "Succeeded", or "Failed 429" with the HTTP status the client got. */
export function useStatusText(record: RequestRecord): string {
  const { t } = useT("requests");
  if (record.success) return t("ok");
  return record.status ? `${t("fail")} ${record.status}` : t("fail");
}

/**
 * The row's status as a round node on the time rail: a tick on green, a cross on red. Screen
 * readers hear the status in words, with the HTTP status of a failure.
 */
export function StatusNode({ record }: { record: RequestRecord }): JSX.Element {
  const label = useStatusText(record);
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full",
        record.success
          ? "bg-success-surface text-success-foreground"
          : "bg-error-surface text-destructive-foreground",
      )}
      data-slot="request-status"
      data-status={record.success ? "success" : "failed"}
    >
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3"
        icon={record.success ? Tick02Icon : Cancel01Icon}
        strokeWidth={2.5}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The rail the rows hang on: a hairline through the row at the node's centre (the first cell's
 * or the row's side padding plus half the node), broken around the node so the node's soft tint
 * never shows it through. `table`: the node sits mid-cell; `card`: on the header line.
 */
export function Rail({ variant }: { variant: "table" | "card" }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 start-6.5 flex w-px flex-col sm:start-8.5"
      data-slot="request-rail"
    >
      <span className={cn("w-px bg-border", variant === "table" ? "flex-1" : "h-3.5")} />
      <span className="h-7 shrink-0" />
      <span className="w-px flex-1 bg-border" />
    </span>
  );
}

/** The clock time for today's rows, the date for older ones (the age above says the rest). */
export function whenText(ts: number, lang: Lang, now: Date = new Date()): string {
  return unixToDate(ts).toDateString() === now.toDateString()
    ? formatTime(ts, lang)
    : formatRowDate(ts, lang, now);
}

/** "3s ago" over the clock time; the age's tooltip holds the full date and time. */
export function WhenStack({
  record,
  children,
}: {
  record: RequestRecord;
  /** A third line (the error category where the Error column is hidden). */
  children?: ReactNode;
}): JSX.Element {
  const { lang } = useT("requests");
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <RelativeTime style="narrow" value={record.ts} />
      {record.ts ? (
        <span className="text-meta text-muted-foreground tabular-nums">
          {whenText(record.ts, lang)}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** The same two parts on one line, as a narrow row's title. */
export function WhenInline({ record }: { record: RequestRecord }): JSX.Element {
  const { lang } = useT("requests");
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <RelativeTime style="narrow" value={record.ts} />
      {record.ts ? (
        <span className="font-normal text-muted-foreground text-xs tabular-nums">
          {whenText(record.ts, lang)}
        </span>
      ) : null}
    </span>
  );
}

interface TokenParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function tokenParts(record: RequestRecord): TokenParts {
  return {
    input: record.inTokens,
    output: record.outTokens,
    cacheRead: record.cacheReadTokens ?? 0,
    cacheWrite: record.cacheWriteTokens ?? 0,
    total: record.inTokens + record.outTokens,
  };
}

/** A failure that used no tokens shows a dash, not a row of zeros. */
export function usedNoTokens(record: RequestRecord): boolean {
  const parts = tokenParts(record);
  return !record.success && parts.total + parts.cacheRead + parts.cacheWrite === 0;
}

/**
 * The request's tokens as one stacked bar scaled to its own total: input not read from the
 * cache, the cache read (a lighter step of the input colour; it is part of the input) and the
 * output, in the detail sheet's colours. A 2 px floor keeps a small part visible.
 */
export function TokenBar({
  record,
  className,
}: {
  record: RequestRecord;
  className?: string;
}): JSX.Element {
  const { input, output, cacheRead } = tokenParts(record);
  const read = Math.min(cacheRead, input);
  const parts = [
    { key: "input", value: input - read, className: "bg-chart-1" },
    { key: "cacheRead", value: read, className: "bg-chart-1/40" },
    { key: "output", value: output, className: "bg-chart-2" },
  ];
  return (
    <span
      aria-hidden="true"
      className={cn("flex h-1.5 overflow-hidden rounded-full bg-chart-grid", className)}
      data-slot="token-bar"
    >
      {parts.map((part) =>
        part.value > 0 ? (
          <span
            className={cn("h-full min-w-0.5 basis-0", part.className)}
            data-part={part.key}
            key={part.key}
            // Each part grows by its count: the split is row data, so it stays an inline style.
            style={{ flexGrow: part.value }}
          />
        ) : null,
      )}
    </span>
  );
}

function FigureIcon({ icon }: { icon: IconSvgElement }): JSX.Element {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className="size-3 shrink-0 text-muted-foreground/70"
      icon={icon}
    />
  );
}

/**
 * All four counts on a muted line, as the token column has always read them: "input → output",
 * then the cache read (a database mark) and the cache write (a database-plus mark), zero or not.
 * Screen readers hear each count's name. Where the line does not fit, the cache counts wrap
 * under it whole; none is ever cut off.
 */
export function TokenFigures({
  record,
  className,
}: {
  record: RequestRecord;
  className?: string;
}): JSX.Element {
  const { t, lang } = useT();
  const { input, output, cacheRead, cacheWrite } = tokenParts(record);
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground tabular-nums leading-none",
        className,
      )}
      data-slot="token-figures"
    >
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <span className="sr-only">{t("tokens.in")}</span>
        <span>{formatCompact(input, lang)}</span>
        <FigureIcon icon={ArrowRight02Icon} />
        <span className="sr-only">{t("tokens.out")}</span>
        <span>{formatCompact(output, lang)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <FigureIcon icon={DatabaseIcon} />
        <span className="sr-only">{t("tokens.cacheRead")}</span>
        <span>{formatCompact(cacheRead, lang)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <FigureIcon icon={DatabaseAddIcon} />
        <span className="sr-only">{t("tokens.cacheWrite")}</span>
        <span>{formatCompact(cacheWrite, lang)}</span>
      </span>
    </span>
  );
}

/** The total in medium weight beside the bar. */
export function TokenTotalBar({
  record,
  className,
}: {
  record: RequestRecord;
  className?: string;
}): JSX.Element {
  const { t, lang } = useT();
  const { total } = tokenParts(record);
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="min-w-10 shrink-0 font-medium tabular-nums">
        <span className="sr-only">{t("tokens.total")} </span>
        {formatCompact(total, lang)}
      </span>
      <TokenBar className="min-w-8 flex-1" record={record} />
    </span>
  );
}

/**
 * The Tokens cell: the total and the bar, the four counts under them, and every count in full as
 * the tooltip (the same list the column has always shown). Not a tab stop: the counts are
 * visible text and the row opens a detail view with every number.
 */
export function TokenUsage({
  record,
  className,
}: {
  record: RequestRecord;
  /** The cell's width steps (the bar takes what the total leaves). */
  className?: string;
}): JSX.Element {
  const { t, lang } = useT();
  if (usedNoTokens(record)) return <Muted />;
  const { input, output, cacheRead, cacheWrite, total } = tokenParts(record);
  const rows: [string, number][] = [
    [t("tokens.in"), input],
    [t("tokens.out"), output],
    [t("tokens.cacheRead"), cacheRead],
    [t("tokens.cacheWrite"), cacheWrite],
    [t("tokens.total"), total],
  ];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("flex min-w-0 flex-col gap-1.5 text-left", className)}
            data-slot="token-usage"
          />
        }
      >
        <TokenTotalBar record={record} />
        <TokenFigures record={record} />
      </TooltipTrigger>
      <TooltipPopup>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 py-0.5">
          {rows.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{formatNumber(value, lang)}</dd>
            </div>
          ))}
        </dl>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The credits as plain text: the figure in semibold and a muted "cr"; a dash for a failure that cost nothing. */
export function CreditsChip({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  if (!record.success && record.credits === 0) return <Muted />;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums">
      <span className="font-semibold">
        <CreditAmount value={record.credits} />
      </span>
      <span className="text-meta text-muted-foreground">{t("creditsUnit")}</span>
    </span>
  );
}

export type SpeedTone = "fast" | "normal" | "slow" | "crawl";

/** How quick a request was: under 3 s fast, under 20 s normal, under 90 s slow, then a crawl. */
export function speedTone(ms: number | undefined): SpeedTone {
  const value = ms ?? 0;
  if (value < 3_000) return "fast";
  if (value < 20_000) return "normal";
  if (value < 90_000) return "slow";
  return "crawl";
}

/** The duration as plain muted text; a dash on rows logged before durations were. */
export function DurationChip({ record }: { record: RequestRecord }): JSX.Element {
  const { lang } = useT("requests");
  const text = formatDurationMs(record.durationMs, Boolean(record.endpoint), lang);
  if (text === EMPTY) return <Muted />;
  return (
    <span
      className="whitespace-nowrap text-muted-foreground tabular-nums"
      data-speed={speedTone(record.durationMs)}
    >
      {text}
    </span>
  );
}

/*
 * Output speed, from the rates Claude writes at once a reply has started: Haiku about 100-150
 * tokens a second, Sonnet 50-80 and Opus 30-50. The row's figure is over the whole request, the
 * wait for the first token included, so it reads lower than those, most for a short reply: under
 * 20 tok/s is slow for any model, and 80 tok/s or more (a quick Sonnet, any Haiku) is fast.
 */
const SLOW_TOKENS_PER_SECOND = 20;
const FAST_TOKENS_PER_SECOND = 80;

export type OutputSpeedTone = "fast" | "normal" | "slow";

/**
 * Output tokens a second over the whole request; undefined when it cannot be worked out: a
 * failure, no output or no duration.
 */
export function outputSpeed(record: RequestRecord): number | undefined {
  const ms = record.durationMs ?? 0;
  if (!record.success || record.outTokens <= 0 || !(ms > 0)) return undefined;
  return record.outTokens / (ms / 1000);
}

export function outputSpeedTone(tokensPerSecond: number): OutputSpeedTone {
  if (tokensPerSecond < SLOW_TOKENS_PER_SECOND) return "slow";
  if (tokensPerSecond >= FAST_TOKENS_PER_SECOND) return "fast";
  return "normal";
}

/** "52 tok/s" as plain muted text, as the duration; a dash when it cannot be worked out. */
export function SpeedChip({ record }: { record: RequestRecord }): JSX.Element {
  const { t, lang } = useT("requests");
  const speed = outputSpeed(record);
  if (speed === undefined) return <Muted />;
  const tone = outputSpeedTone(speed);
  // One decimal under 10 tok/s, so a slow trickle never reads 0.
  const value =
    speed >= 10
      ? formatNumber(Math.round(speed), lang)
      : roundsToZero(speed, 1)
        ? belowStep(1, lang)
        : formatDecimal(speed, 1, lang);
  return (
    <span className="whitespace-nowrap text-muted-foreground tabular-nums" data-output-speed={tone}>
      {t("speed.value", { n: value })}
    </span>
  );
}

/**
 * The share of the input read from the cache, 0 to 1; undefined without input. The cache read
 * is part of the input (proxy/cache_stats.go caps it at the input total), so it is divided by the
 * input, not added to it.
 */
export function cacheHitShare(record: RequestRecord): number | undefined {
  if (!(record.inTokens > 0)) return undefined;
  return Math.min(Math.max(record.cacheReadTokens ?? 0, 0) / record.inTokens, 1);
}

/**
 * The cache hit as a whole percent beside a small meter; a dash without input. `labelled` puts
 * "Cache hit" before it, for a narrow row with no column header.
 */
export function CacheHit({
  record,
  labelled = false,
}: {
  record: RequestRecord;
  labelled?: boolean;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const share = cacheHitShare(record);
  if (share === undefined) return <Muted />;
  // A hit under half a percent reads "<1%", so a small one never looks like none.
  const text =
    share > 0 && share < 0.005
      ? `<${formatFraction(0.01, 0, lang)}`
      : formatFraction(share, 0, lang);
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" data-slot="cache-hit">
      <span className={cn(!labelled && "sr-only", "text-muted-foreground")}>{t("cacheHit")}</span>
      <span className="min-w-8 font-medium">{text}</span>
      {/* Decorative: the percent says it. */}
      <Meter aria-hidden="true" className="w-12 shrink-0" max={1} min={0} value={share}>
        <MeterTrack>
          <MeterIndicator />
        </MeterTrack>
      </Meter>
    </span>
  );
}

/** "req_2dc2…": the prefix and the first four hex digits, enough to tell rows apart. */
export function shortRequestId(id: string): string {
  return id.length > 9 ? `${id.slice(0, 8)}…` : id;
}

/**
 * The request ID the client got, short in mono (the whole ID as its tooltip), with a copy button
 * for the whole ID, so a key holder can quote it to the admin; a dash on rows logged before it.
 */
export function RequestIdCopy({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  const id = record.requestId;
  if (!id) return <Muted />;
  return (
    <span className="inline-flex items-center gap-0.5" data-slot="request-id">
      <Tooltip>
        <TooltipTrigger
          render={<span className="font-mono text-meta text-muted-foreground" translate="no" />}
        >
          <span className="sr-only">{t("requestId")} </span>
          {shortRequestId(id)}
        </TooltipTrigger>
        <TooltipPopup className="font-mono">{id}</TooltipPopup>
      </Tooltip>
      <CopyButton label={t("copyRequestId")} size="icon-xs" value={id} />
    </span>
  );
}

const ERROR_BADGE = {
  muted: "neutral",
  warning: "warning",
  destructive: "destructive",
} as const satisfies Record<ErrorTone, "neutral" | "warning" | "destructive">;

/**
 * The HTTP status the client got as a small pill (neutral on a success, the error's tier colour
 * on a failure), with how many upstream attempts the request took: under it in a table cell,
 * beside it on a narrow row. No count for a request refused before any attempt.
 */
export function HttpStatus({
  record,
  inline = false,
}: {
  record: RequestRecord;
  inline?: boolean;
}): JSX.Element {
  const { t } = useT("requests");
  const tries = requestTries(record);
  const tone = record.success ? "neutral" : ERROR_BADGE[errorTypeTone(record.errorType)];
  return (
    <span
      className={cn("flex", inline ? "items-center gap-2" : "flex-col items-start gap-1")}
      data-slot="http-status"
    >
      {record.status ? (
        <Badge data-tone={tone} size="sm" tone={tone}>
          <span className="sr-only">{t("http")} </span>
          {record.status}
        </Badge>
      ) : (
        <Muted />
      )}
      {tries > 0 ? (
        <span
          className={cn(
            "whitespace-nowrap text-meta tabular-nums",
            // A retried request stands out from the usual single try.
            tries > 1 ? "font-medium text-foreground" : "text-muted-foreground",
          )}
          data-tries={tries}
        >
          {t("tries", { count: tries })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A failure's category as a pill in its tier's colour, with the HTTP status the client got
 * (left out with `status={false}`, beside an HTTP status column that shows it).
 */
export function ErrorPill({
  record,
  status = true,
}: {
  record: RequestRecord;
  status?: boolean;
}): JSX.Element {
  const { t } = useT("requests");
  const type = record.errorType;
  const label = type ? (isKnownErrorType(type) ? t(`errorType.${type}`) : type) : t("fail");
  return (
    <Badge data-tone={errorTypeTone(type)} size="sm" tone={ERROR_BADGE[errorTypeTone(type)]}>
      {label}
      {status && record.status ? ` · ${record.status}` : ""}
    </Badge>
  );
}

/**
 * A failure's message: for a Proxy error the plain sentence its Attempts show, otherwise the
 * error the client got. `raw` is always the client's error, for the tooltip.
 */
export function useErrorMessage(record: RequestRecord): { text: string; raw: string } {
  const { t } = useT("requests");
  const maskText = useMaskText();
  const raw = maskText(record.message) || t("noErrorMessage");
  return { text: requestProxyText(record, t) ?? raw, raw };
}

/** The message on one muted line, cut with an ellipsis; the whole error is the tooltip. */
export function ErrorMessage({
  record,
  className,
}: {
  record: RequestRecord;
  className?: string;
}): JSX.Element {
  const { text, raw } = useErrorMessage(record);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("block max-w-full truncate text-meta text-muted-foreground", className)}
            data-slot="error-message"
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm whitespace-pre-wrap wrap-break-word">{raw}</TooltipPopup>
    </Tooltip>
  );
}

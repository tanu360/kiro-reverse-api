import {
  ArrowRight02Icon,
  Cancel01Icon,
  Coins01Icon,
  DatabaseAddIcon,
  DatabaseIcon,
  Tick02Icon,
  Timer01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestRecord } from "@/lib/api/types";
import {
  EMPTY,
  formatCompact,
  formatDurationMs,
  formatNumber,
  formatTime,
  unixToDate,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { requestProxyText } from "./proxy-failure";
import { type ErrorTone, errorTypeTone, formatRowDate, isKnownErrorType } from "./request-model";

/*
 * The pieces of a Requests row, shared by the table cells and the narrow-layout row: the status
 * node on the time rail, the token bar, the credits and duration chips and the error pill.
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

type ChipTone = "neutral" | "primary" | "success" | "warning" | "destructive";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border-border-subtle bg-surface-2 text-foreground",
  primary: "border-transparent bg-info-surface font-medium text-info-foreground",
  success: "border-transparent bg-success-surface text-success-foreground",
  warning: "border-transparent bg-warning-surface text-warning-foreground",
  destructive: "border-transparent bg-error-surface text-destructive-foreground",
};

/** A figure on a small square chip with its mark; the mark's name is for screen readers. */
function FigureChip({
  icon,
  label,
  tone = "neutral",
  children,
}: {
  icon: IconSvgElement;
  label: string;
  tone?: ChipTone;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs tabular-nums leading-none",
        CHIP_TONE[tone],
      )}
      data-slot="figure-chip"
      data-tone={tone}
    >
      <HugeiconsIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" icon={icon} />
      <span className="sr-only">{label}</span>
      {children}
    </span>
  );
}

/** The credits on the brand-tinted chip; a dash for a failure that cost nothing. */
export function CreditsChip({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  if (!record.success && record.credits === 0) return <Muted />;
  return (
    <FigureChip icon={Coins01Icon} label={t("credits")} tone="primary">
      <CreditAmount value={record.credits} />
    </FigureChip>
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

const SPEED_CHIP: Record<SpeedTone, ChipTone> = {
  fast: "success",
  normal: "neutral",
  slow: "warning",
  crawl: "destructive",
};

/** The duration on a chip tinted by speed; a dash on rows logged before durations were. */
export function DurationChip({ record }: { record: RequestRecord }): JSX.Element {
  const { t, lang } = useT("requests");
  const text = formatDurationMs(record.durationMs, Boolean(record.endpoint), lang);
  if (text === EMPTY) return <Muted />;
  const tone = speedTone(record.durationMs);
  return (
    <span className="inline-flex" data-speed={tone}>
      <FigureChip icon={Timer01Icon} label={t("duration")} tone={SPEED_CHIP[tone]}>
        {text}
      </FigureChip>
    </span>
  );
}

const ERROR_BADGE = {
  muted: "neutral",
  warning: "warning",
  destructive: "destructive",
} as const satisfies Record<ErrorTone, "neutral" | "warning" | "destructive">;

/** A failure's category as a pill in its tier's colour, with the HTTP status the client got. */
export function ErrorPill({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  const type = record.errorType;
  const label = type ? (isKnownErrorType(type) ? t(`errorType.${type}`) : type) : t("fail");
  return (
    <Badge data-tone={errorTypeTone(type)} size="sm" tone={ERROR_BADGE[errorTypeTone(type)]}>
      {label}
      {record.status ? ` · ${record.status}` : ""}
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

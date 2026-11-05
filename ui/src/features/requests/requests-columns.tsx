import { CircleXIcon } from "@hugeicons/core-free-icons";
import { type JSX, useMemo } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import type { DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { ListCard } from "@/components/shared/list-card";
import { StatusDot } from "@/components/shared/status-dot";
import { TokenCell } from "@/components/shared/token-cell";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestRecord } from "@/lib/api/types";
import {
  EMPTY,
  formatCompact,
  formatCredits,
  formatDateTime,
  formatDurationMs,
  formatTime,
  unixToDate,
} from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { ErrorTypeLabel } from "./error-type-badge";
import { formatRowDate, isKnownEndpoint, normalizeApiKeyMask } from "./request-model";

/*
 * Width caps that keep the table inside a 1024 px desktop with the sidebar open (and a 820 px
 * tablet): names and the token breakdown cut with an ellipsis (tooltips carry the full text) until
 * the 7xl container step has room for them.
 */
const NAME_CAP = "max-w-28 @5xl/requests:max-w-32 @7xl/requests:max-w-40";
// Model IDs differ only in their version suffix, so the model gets more room than the token line.
const MODEL_CAP = "max-w-32 @5xl/requests:max-w-40 @7xl/requests:max-w-48";
const TOKENS_CAP = "max-w-36 @7xl/requests:max-w-none";

function Muted({ children = EMPTY }: { children?: string }): JSX.Element {
  return <span className="text-muted-foreground">{children}</span>;
}

/**
 * A success is quiet (a green dot and a muted label); a failure is the page's one red pill, with
 * the HTTP status in it.
 */
export function StatusBadge({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  if (record.success) {
    return (
      // The pill's metrics (24 px, 12 px medium label), without the pill.
      <span className="inline-flex h-6 items-center gap-2 font-medium text-muted-foreground text-xs">
        <StatusDot tone="success" />
        {t("ok")}
      </span>
    );
  }
  return (
    <Badge icon={CircleXIcon} tone="destructive">
      {t("fail")}
      {record.status ? ` ${record.status}` : ""}
    </Badge>
  );
}

/** A masked API key in mono, cut with an ellipsis (the full mask as a tooltip when cut). */
export function ApiKeyCode({
  value,
  className,
}: {
  value?: string;
  className?: string;
}): JSX.Element {
  const masked = normalizeApiKeyMask(value);
  if (!masked) return <Muted />;
  return <TruncatedText className={cn("font-mono text-meta", className)}>{masked}</TruncatedText>;
}

export function endpointLabel(endpoint: string | undefined, t: TFunction): string {
  return isKnownEndpoint(endpoint) ? t(`endpoint.${endpoint}`) : EMPTY;
}

function useErrorMessage(record: RequestRecord): string {
  const { t } = useT("requests");
  const maskText = useMaskText();
  return maskText(record.message) || t("noErrorMessage");
}

/** The category over a two-line message; the tooltip holds the whole message. */
function ErrorCell({ record }: { record: RequestRecord }): JSX.Element {
  const message = useErrorMessage(record);
  if (record.success) return <Muted />;
  return (
    <div className="flex min-w-32 max-w-72 flex-col items-start gap-1">
      <ErrorTypeLabel className="text-meta" type={record.errorType} />
      <Tooltip>
        <TooltipTrigger
          render={
            // `wrap-anywhere`, not `break-words`: an unbroken token (a JSON body, a URL) would
            // otherwise set the column's minimum width and scroll the table sideways at 1440 px.
            <span className="line-clamp-2 whitespace-normal text-meta text-muted-foreground leading-snug wrap-anywhere" />
          }
        >
          {message}
        </TooltipTrigger>
        <TooltipPopup className="max-w-sm whitespace-pre-wrap break-words">{message}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * The status pill; below a 64rem container (where the Error column is hidden) the error
 * category rides under it.
 */
function StatusCell({ record }: { record: RequestRecord }): JSX.Element {
  return (
    <span className="flex flex-col items-start gap-1">
      <StatusBadge record={record} />
      {!record.success && record.errorType ? (
        <ErrorTypeLabel
          className="text-meta text-muted-foreground @5xl/requests:hidden"
          type={record.errorType}
        />
      ) : null}
    </span>
  );
}

/**
 * Account over API key. The key has its own column from a 68rem (1088 px) container up; below it
 * the key rides here as a meta line.
 */
function AccountCell({ record }: { record: RequestRecord }): JSX.Element {
  const key = normalizeApiKeyMask(record.apiKeyMasked);
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <DisplayEmail className={NAME_CAP} email={record.email} id={record.accountId} />
      {key ? (
        <ApiKeyCode
          className={cn(NAME_CAP, "text-muted-foreground @[68rem]/requests:hidden")}
          value={key}
        />
      ) : null}
    </span>
  );
}

/**
 * Model over endpoint. The endpoint has its own column from the 7xl container width up; below
 * it the endpoint rides here as a meta line, like the date under the time.
 */
function ModelCell({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  const endpoint = endpointLabel(record.endpoint, t);
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {record.model ? (
        <TruncatedText className={MODEL_CAP}>{record.model}</TruncatedText>
      ) : (
        <Muted />
      )}
      {endpoint === EMPTY ? null : (
        <span className="text-meta text-muted-foreground @7xl/requests:hidden">{endpoint}</span>
      )}
    </span>
  );
}

/** Credits; below a 64rem container (no Duration column) the duration rides under them. */
function CreditsCell({ record }: { record: RequestRecord }): JSX.Element {
  const { lang } = useT("requests");
  const duration = formatDurationMs(record.durationMs, Boolean(record.endpoint), lang);
  return (
    <span className="flex flex-col items-end gap-1">
      {!record.success && record.credits === 0 ? (
        <Muted />
      ) : (
        <CreditAmount value={record.credits} />
      )}
      <span className="text-meta text-muted-foreground @5xl/requests:hidden">{duration}</span>
    </span>
  );
}

/**
 * Time over date: two short lines keep the column narrow. `inline` puts them on one line (a
 * card's title). The year shows on older rows, so no tooltip is needed.
 */
export function TimeCell({
  ts,
  lang,
  inline = false,
}: {
  ts: number;
  lang: Lang;
  inline?: boolean;
}): JSX.Element {
  const dateTime = unixToDate(ts).toISOString();
  if (inline) {
    return (
      <time className="tabular-nums" dateTime={dateTime}>
        {formatTime(ts, lang)}{" "}
        <span className="font-normal text-muted-foreground">{formatRowDate(ts, lang)}</span>
      </time>
    );
  }
  return (
    <time className="flex flex-col gap-1 tabular-nums" dateTime={dateTime}>
      <span>{formatTime(ts, lang)}</span>
      <span className="text-meta text-muted-foreground">{formatRowDate(ts, lang)}</span>
    </time>
  );
}

/**
 * A request as a list row, for narrow containers: time and status, the account, the model and
 * endpoint, then tokens, credits and duration on one muted line. A failure adds its category and
 * a two-line message. The whole row opens the detail sheet.
 */
export function RequestCard({
  record,
  onOpen,
}: {
  record: RequestRecord;
  onOpen: () => void;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const message = useErrorMessage(record);
  const endpoint = endpointLabel(record.endpoint, t);
  const failed = !record.success;
  const total = record.inTokens + record.outTokens;
  const duration = formatDurationMs(record.durationMs, Boolean(record.endpoint), lang);
  const figures = [
    failed && total === 0 ? null : t("card.tokens", { value: formatCompact(total, lang) }),
    failed && record.credits === 0
      ? null
      : t("card.credits", { value: formatCredits(record.credits, 2, lang) }),
    duration === EMPTY ? null : duration,
  ].filter((part): part is string => part !== null);

  return (
    <ListCard
      badge={<StatusBadge record={record} />}
      meta={<DisplayEmail email={record.email} id={record.accountId} />}
      onOpen={onOpen}
      openLabel={t("detail.open", { time: formatDateTime(record.ts, lang) })}
      title={<TimeCell inline lang={lang} ts={record.ts} />}
      variant="row"
    >
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        {record.model ? <span className="min-w-0 truncate">{record.model}</span> : <Muted />}
        {endpoint === EMPTY ? null : (
          <span className="shrink-0 text-meta text-muted-foreground">{endpoint}</span>
        )}
      </div>
      {figures.length > 0 ? (
        <p className="truncate text-meta text-muted-foreground tabular-nums">
          {figures.join(" · ")}
        </p>
      ) : null}
      {failed ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <ErrorTypeLabel className="text-meta" type={record.errorType} />
          <p className="line-clamp-2 text-meta text-muted-foreground wrap-anywhere">{message}</p>
        </div>
      ) : null}
    </ListCard>
  );
}

// Tighter cell padding than the table default for the middle columns, so the ten columns fit a
// 1440 px desktop with the sidebar open; the first and last cells take the card's side padding
// (DataTableCard insets them), and wide containers get the default padding back.
const COMPACT_PADDING = "px-2 @7xl/requests:px-2.5";
// Below a 64rem container Credits is the last column shown (Duration and Error are hidden), so it
// takes the card's end padding, as the inset gives the real last cell.
const CREDITS_END = "pe-4 sm:pe-5 @5xl/requests:pe-2 @7xl/requests:pe-2.5";
const WIDE_ONLY = "hidden @5xl/requests:table-cell";

function withCompactPadding(
  columns: DataTableColumn<RequestRecord>[],
): DataTableColumn<RequestRecord>[] {
  const last = columns.length - 1;
  return columns.map((column, index) =>
    index === 0 || index === last
      ? column
      : {
          ...column,
          className: cn(COMPACT_PADDING, column.className),
          headerClassName: cn(COMPACT_PADDING, column.headerClassName),
        },
  );
}

/** The ten Requests columns; ids match the server sort names where a column sorts. */
export function useRequestColumns(): DataTableColumn<RequestRecord>[] {
  const { t, lang } = useT("requests");
  return useMemo<DataTableColumn<RequestRecord>[]>(
    () =>
      withCompactPadding([
        {
          id: "time",
          header: t("time"),
          sortable: true,
          sticky: true,
          width: "5.5rem",
          cell: (row) => <TimeCell lang={lang} ts={row.ts} />,
        },
        {
          id: "status",
          header: t("status"),
          sortable: true,
          width: "7.5rem",
          cell: (row) => <StatusCell record={row} />,
        },
        {
          id: "account",
          header: t("account"),
          sortable: true,
          cell: (row) => <AccountCell record={row} />,
        },
        {
          id: "api_key",
          header: t("apiKey"),
          sortable: true,
          width: "8.5rem",
          // Below a 68rem container the key shows under the account instead.
          className: "hidden @[68rem]/requests:table-cell",
          headerClassName: "hidden @[68rem]/requests:table-cell",
          cell: (row) => <ApiKeyCode value={row.apiKeyMasked} />,
        },
        {
          id: "endpoint",
          header: t("endpoint"),
          // Below the 7xl container width the endpoint shows under the model instead.
          className: "hidden @7xl/requests:table-cell",
          headerClassName: "hidden @7xl/requests:table-cell",
          cell: (row) => {
            const label = endpointLabel(row.endpoint, t);
            return label === EMPTY ? <Muted /> : label;
          },
        },
        {
          id: "model",
          header: t("model"),
          sortable: true,
          cell: (row) => <ModelCell record={row} />,
        },
        {
          id: "tokens",
          header: t("tokens"),
          sortable: true,
          cell: (row) => (
            <TokenCell
              cacheReadTokens={row.cacheReadTokens}
              cacheWriteTokens={row.cacheWriteTokens}
              detailClassName={TOKENS_CAP}
              inTokens={row.inTokens}
              muteZero={!row.success}
              outTokens={row.outTokens}
            />
          ),
        },
        {
          id: "credits",
          header: t("credits"),
          sortable: true,
          align: "end",
          width: "5rem",
          className: CREDITS_END,
          headerClassName: CREDITS_END,
          cell: (row) => <CreditsCell record={row} />,
        },
        {
          id: "duration",
          header: t("duration"),
          sortable: true,
          align: "end",
          width: "5.5rem",
          // Below a 64rem container the duration shows under the credits instead.
          className: WIDE_ONLY,
          headerClassName: WIDE_ONLY,
          cell: (row) => formatDurationMs(row.durationMs, Boolean(row.endpoint), lang),
        },
        {
          id: "error",
          header: t("error"),
          // Below a 64rem container the category shows under the status instead.
          className: WIDE_ONLY,
          headerClassName: WIDE_ONLY,
          cell: (row) => <ErrorCell record={row} />,
        },
      ]),
    [t, lang],
  );
}

import { CircleXIcon } from "@hugeicons/core-free-icons";
import { type JSX, useMemo } from "react";
import type { DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { ListCard } from "@/components/shared/list-card";
import { ModelLogo } from "@/components/shared/model-logo";
import { StatusDot } from "@/components/shared/status-dot";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { ErrorTypeLabel } from "./error-type-badge";
import {
  CacheHit,
  CreditsChip,
  DurationChip,
  ErrorMessage,
  ErrorPill,
  Muted,
  outputSpeed,
  Rail,
  RequestIdCopy,
  SpeedChip,
  StatusNode,
  TokenFigures,
  TokenTotalBar,
  TokenUsage,
  usedNoTokens,
  WhenInline,
  WhenStack,
} from "./request-cells";
import { CallerLabel, requestCaller } from "./request-client";
import { isKnownEndpoint, normalizeApiKeyMask } from "./request-model";

/*
 * Width caps that keep the table inside a 1024 px desktop with the sidebar open (and a 768-820 px
 * tablet): names and the token figures cut with an ellipsis (tooltips carry the full text) until
 * the 7xl container step has room for them.
 */
const NAME_CAP = "max-w-28 @5xl/requests:max-w-32 @7xl/requests:max-w-40";
// Model IDs differ only in their version suffix, so the model gets more room than the token line.
// No 112 px step: at 1024 px with the sidebar open it cut every claude-sonnet-* to the same text.
const MODEL_CAP = "max-w-32 @5xl/requests:max-w-40 @7xl/requests:max-w-48";
// Without the Account and API key columns (a key holder's table) the model has their room.
const MODEL_CAP_WIDE = "max-w-40 @5xl/requests:max-w-56 @7xl/requests:max-w-72";
// One width per step, so every row's bar has the same length (each scaled to its own total).
const TOKENS_WIDTH = "w-40 @5xl/requests:w-44 @7xl/requests:w-52";

/**
 * What the rows show beyond the request itself; `accounts` and `messages` default to true and
 * `details` to false (the Requests page).
 */
export interface RequestViewOptions {
  /**
   * The Account and API key columns and a card's account line. Off for a key holder's own
   * requests (the user panel): their API sends neither.
   */
  accounts?: boolean;
  /**
   * A failure's message under its category. Off for a key holder: their API sends only the
   * category.
   */
  messages?: boolean;
  /**
   * The Speed, Cache hit and Request ID columns, and their line on a card. On for a key holder,
   * whose table has the room the Account and API key columns leave; the Requests page shows
   * these in its sheet.
   */
  details?: boolean;
}

/**
 * A success is quiet (a green dot and a muted label); a failure is the page's one red pill, with
 * the HTTP status in it.
 */
export function StatusBadge({
  record,
  size,
}: {
  record: RequestRecord;
  /** The Badge size; `sm` (20 px) beside the detail sheet's meta line. */
  size?: "sm";
}): JSX.Element {
  const { t } = useT("requests");
  if (record.success) {
    return (
      // The pill's metrics (24 px, or 20 px small; 12 px medium label), without the pill.
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-2 font-medium text-muted-foreground text-xs",
          size === "sm" ? "h-5" : "h-6",
        )}
      >
        <StatusDot tone="success" />
        {t("ok")}
      </span>
    );
  }
  return (
    <Badge icon={CircleXIcon} size={size} tone="destructive">
      {t("fail")}
      {record.status ? ` ${record.status}` : ""}
    </Badge>
  );
}

/**
 * A masked API key in mono, cut with an ellipsis (the full mask as a tooltip when cut): 14 px and
 * muted like the duration in its own column, 12 px as the meta line under the account.
 */
function ApiKeyCode({
  value,
  className = "text-sm text-muted-foreground",
}: {
  value?: string;
  className?: string;
}): JSX.Element {
  const masked = normalizeApiKeyMask(value);
  if (!masked) return <Muted />;
  return <TruncatedText className={cn("font-mono", className)}>{masked}</TruncatedText>;
}

/** A client API by the name the table's caller line uses ("Anthropic API"), or the empty dash. */
export function endpointLabel(endpoint: string | undefined, t: TFunction): string {
  return isKnownEndpoint(endpoint) ? t(`client.${endpoint}`) : EMPTY;
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
          className={cn(NAME_CAP, "text-meta text-muted-foreground @[68rem]/requests:hidden")}
          value={key}
        />
      ) : null}
    </span>
  );
}

/**
 * The status node on the time rail, beside the age over the clock time. Where the Error column is
 * hidden (below a 56rem container, or 72rem with the detail columns) a failure's category rides
 * under them; `errorShown` is the class that hides it again once the column shows.
 */
function TimeCell({
  record,
  errorShown,
}: {
  record: RequestRecord;
  errorShown: string;
}): JSX.Element {
  return (
    <>
      <Rail variant="table" />
      <span className="flex items-center gap-3">
        <StatusNode record={record} />
        <WhenStack record={record}>
          {!record.success && record.errorType ? (
            <ErrorTypeLabel
              className={cn("max-w-24 text-meta text-muted-foreground", errorShown)}
              type={record.errorType}
            />
          ) : null}
        </WhenStack>
      </span>
    </>
  );
}

/** The model's mark and name over the caller: the coding tool, else the client API. */
function ModelCell({ record, cap }: { record: RequestRecord; cap: string }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {record.model ? (
        <span className="flex min-w-0 items-center gap-2">
          <ModelLogo model={record.model} />
          <TruncatedText className={cn("font-medium", cap)}>{record.model}</TruncatedText>
        </span>
      ) : (
        <Muted />
      )}
      <CallerLabel
        className={cn("text-meta text-muted-foreground", record.model && "ps-6")}
        record={record}
      />
    </span>
  );
}

/** The credits chip; below a 56rem container (no Duration column) the duration chip under it. */
function CreditsCell({ record }: { record: RequestRecord }): JSX.Element {
  return (
    <span className="flex flex-col items-start gap-1">
      <CreditsChip record={record} />
      <span className="@4xl/requests:hidden">
        <DurationChip record={record} />
      </span>
    </span>
  );
}

/**
 * The duration chip; with the detail columns, below a 72rem container (no Speed column) the
 * speed chip under it.
 */
function DurationCell({
  record,
  details,
}: {
  record: RequestRecord;
  details: boolean;
}): JSX.Element {
  if (!details || outputSpeed(record) === undefined) return <DurationChip record={record} />;
  return (
    <span className="flex flex-col items-start gap-1">
      <DurationChip record={record} />
      <span className="@6xl/requests:hidden">
        <SpeedChip record={record} />
      </span>
    </span>
  );
}

/** The category pill over the message (the message on the admin table only, from 64rem). */
function ErrorCell({
  record,
  showMessage,
  showStatus,
}: {
  record: RequestRecord;
  showMessage: boolean;
  showStatus: boolean;
}): JSX.Element {
  if (record.success) return <Muted />;
  return (
    <span className="flex min-w-0 max-w-40 flex-col items-start gap-1 @7xl/requests:max-w-64">
      <ErrorPill record={record} status={showStatus} />
      {showMessage ? <ErrorMessage className="hidden @5xl/requests:block" record={record} /> : null}
    </span>
  );
}

/**
 * What tells one request from another that started the same minute, read after its name
 * ("Request details, <time>"): the model, the outcome and, where accounts show, the account.
 */
export function useRequestSummary(accounts = true): (record: RequestRecord) => string {
  const { t } = useT("requests");
  const displayEmail = useDisplayEmail();
  return (record) =>
    [
      record.model,
      record.success ? t("ok") : `${t("fail")}${record.status ? ` ${record.status}` : ""}`,
      accounts ? displayEmail(record.email, record.accountId) : "",
    ]
      .filter(Boolean)
      .join(", ");
}

/**
 * A request as a list row, for narrow containers: the status node and the age, then (indented
 * past the node) the model and caller, the token bar with the credits and duration chips, the
 * four token counts, the account, and a failure's category and message. With `details` the
 * request ID and its copy button sit at the header's end, and the speed and the cache hit, when
 * either is known, get a line under the token counts. With `onOpen` the whole row
 * opens the detail sheet; without it the row is plain text.
 */
export function RequestCard({
  record,
  onOpen,
  accounts = true,
  messages = true,
  details = false,
}: {
  record: RequestRecord;
  onOpen?: () => void;
} & RequestViewOptions): JSX.Element {
  const { t, lang } = useT("requests");
  const summary = useRequestSummary(accounts);
  const tokens = !usedNoTokens(record);
  const speed = outputSpeed(record) !== undefined;
  const cache = record.inTokens > 0;
  return (
    <ListCard
      action={details && record.requestId ? <RequestIdCopy record={record} /> : undefined}
      leading={<StatusNode record={record} />}
      onOpen={onOpen}
      openDescription={onOpen ? summary(record) : undefined}
      openLabel={onOpen ? t("detail.open", { time: formatDateTime(record.ts, lang) }) : undefined}
      title={<WhenInline record={record} />}
      variant="row"
    >
      <Rail variant="card" />
      {/* Past the node (20 px and the header's 8 px gap), so the rail runs clear of the text. */}
      <div className="flex min-w-0 flex-col gap-2 ps-7">
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          {record.model ? (
            <>
              <ModelLogo className="size-3.5" model={record.model} />
              <span className="min-w-0 truncate font-medium text-foreground">{record.model}</span>
            </>
          ) : (
            <Muted />
          )}
          {requestCaller(record) ? (
            <>
              <span aria-hidden="true">·</span>
              <CallerLabel className="shrink-0" record={record} />
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {tokens ? <TokenTotalBar className="flex-1" record={record} /> : null}
          {/* Spaced as the speed and cache-hit line, so the credits and the duration read as two
              figures, not one run of grey text. */}
          <div className={cn("flex shrink-0 items-center gap-3", !tokens && "flex-1")}>
            {record.success || record.credits > 0 ? <CreditsChip record={record} /> : null}
            <DurationChip record={record} />
          </div>
        </div>
        {tokens ? <TokenFigures record={record} /> : null}
        {/* Only with a figure to show: a failed request with no tokens gets no empty line. */}
        {details && (speed || cache) ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            {speed ? <SpeedChip record={record} /> : null}
            {cache ? <CacheHit labelled record={record} /> : null}
          </div>
        ) : null}
        {accounts ? (
          <DisplayEmail
            className="text-meta text-muted-foreground"
            email={record.email}
            id={record.accountId}
          />
        ) : null}
        {record.success ? null : (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <ErrorPill record={record} status />
            {messages ? (
              <ErrorMessage
                className="line-clamp-2 whitespace-normal wrap-anywhere"
                record={record}
              />
            ) : null}
          </div>
        )}
      </div>
    </ListCard>
  );
}

// Tighter cell padding than the table default for the middle columns, so the eight columns fit
// a 1440 px desktop with the sidebar open (and a key holder's ten a 1280 px window); the first and
// last cells take the card's side padding (DataTableCard insets them), and wide containers get the
// default padding back.
const COMPACT_PADDING = "px-2 @7xl/requests:px-2.5";
// Below a 56rem container Credits is the last column shown (Duration and Error are hidden), so it
// takes the card's end padding, as the inset gives the real last cell.
const CREDITS_END = "pe-4 sm:pe-6 @4xl/requests:pe-2 @7xl/requests:pe-2.5";
const FROM_4XL = "hidden @4xl/requests:table-cell";
// With the detail columns the table needs a 72rem container for Speed and Error: below it the
// speed rides under the duration and a failure's category under the time.
const FROM_6XL = "hidden @6xl/requests:table-cell";
// Two-line cells with air, and the table's column rules, as on Accounts: they sit on the cells'
// start edges, clear of the time rail in the first cell.
const BODY_CELL = "py-3";
// What `accounts: false` leaves out: middle columns, so dropping them after withCompactPadding
// keeps the first and last cells' padding.
const ACCOUNT_COLUMNS = new Set(["account", "api_key"]);
// What `details: false` leaves out, before withCompactPadding: middle columns, so Error stays
// the last cell either way.
const DETAIL_COLUMNS = new Set(["cache_hit", "speed", "request_id"]);

function withCompactPadding(
  columns: DataTableColumn<RequestRecord>[],
): DataTableColumn<RequestRecord>[] {
  const last = columns.length - 1;
  return columns.map((column, index) => ({
    ...column,
    // The first cell keeps the table's own edge (the pinned column's divider while it scrolls).
    className: cn(
      index === 0 ? "py-3" : BODY_CELL,
      index !== 0 && index !== last && COMPACT_PADDING,
      column.className,
    ),
    headerClassName: cn(index !== 0 && index !== last && COMPACT_PADDING, column.headerClassName),
  }));
}

/**
 * The eight Requests columns; ids match the server sort names where a column sorts. The status
 * has no column of its own: the node on the time rail shows it (and says it to screen readers),
 * a failure's category is the Error column, and "Sort by" still sorts by it. Without `accounts`
 * the Account and API key columns are left out; without `messages` the Error column shows only
 * the category. `details` adds Cache hit after Tokens, Speed after Duration, HTTP before Error and
 * Request ID last; none of them sorts.
 */
export function useRequestColumns({
  accounts = true,
  messages = true,
  details = false,
}: RequestViewOptions = {}): DataTableColumn<RequestRecord>[] {
  const { t } = useT("requests");
  return useMemo<DataTableColumn<RequestRecord>[]>(() => {
    const errorFrom = details ? FROM_6XL : FROM_4XL;
    const columns: DataTableColumn<RequestRecord>[] = [
      {
        id: "time",
        header: t("time"),
        sortable: true,
        sticky: true,
        width: "7.5rem",
        cell: (row) => (
          <TimeCell
            errorShown={details ? "@6xl/requests:hidden" : "@4xl/requests:hidden"}
            record={row}
          />
        ),
      },
      {
        id: "model",
        header: t("model"),
        sortable: true,
        // The detail columns take the room the Account and API key columns leave.
        cell: (row) => (
          <ModelCell cap={accounts || details ? MODEL_CAP : MODEL_CAP_WIDE} record={row} />
        ),
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
        id: "tokens",
        header: t("tokens"),
        sortable: true,
        cell: (row) => <TokenUsage className={TOKENS_WIDTH} record={row} />,
      },
      {
        id: "cache_hit",
        header: t("cacheHit"),
        cell: (row) => <CacheHit record={row} />,
      },
      {
        id: "credits",
        header: t("credits"),
        sortable: true,
        className: CREDITS_END,
        headerClassName: CREDITS_END,
        cell: (row) => <CreditsCell record={row} />,
      },
      {
        id: "duration",
        header: t("duration"),
        sortable: true,
        // Below a 56rem container the duration shows under the credits instead.
        className: FROM_4XL,
        headerClassName: FROM_4XL,
        cell: (row) => <DurationCell details={details} record={row} />,
      },
      {
        id: "speed",
        header: t("speed"),
        // Below a 72rem container the speed shows under the duration instead.
        className: FROM_6XL,
        headerClassName: FROM_6XL,
        cell: (row) => <SpeedChip record={row} />,
      },
      {
        id: "request_id",
        header: t("requestId"),
        cell: (row) => <RequestIdCopy record={row} />,
      },
      {
        id: "error",
        header: t("error"),
        // Where it is hidden the category shows under the time instead.
        className: errorFrom,
        headerClassName: errorFrom,
        // The status code rides in the pill, as on the admin's table (the holder has no message).
        cell: (row) => <ErrorCell record={row} showMessage={messages} showStatus />,
      },
    ];
    return withCompactPadding(
      columns.filter((column) => details || !DETAIL_COLUMNS.has(column.id)),
    ).filter((column) => accounts || !ACCOUNT_COLUMNS.has(column.id));
  }, [t, accounts, messages, details]);
}

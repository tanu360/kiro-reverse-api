import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { type JSX, useMemo } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import type { DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { TokenCell } from "@/components/shared/token-cell";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs, formatTime } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { ErrorTypeBadge } from "./error-type-badge";
import { formatRowDate, isKnownEndpoint, normalizeApiKeyMask } from "./request-model";

function Muted({ children = EMPTY }: { children?: string }): JSX.Element {
  return <span className="text-muted-foreground">{children}</span>;
}

export function StatusBadge({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  if (record.success) {
    return (
      <Badge icon={CircleCheckIcon} tone="success">
        {t("ok")}
      </Badge>
    );
  }
  return (
    <Badge className="tabular-nums" icon={CircleXIcon} tone="destructive">
      {t("fail")}
      {record.status ? ` ${record.status}` : ""}
    </Badge>
  );
}

export function ApiKeyCode({
  value,
  className,
}: {
  value?: string;
  className?: string;
}): JSX.Element {
  const masked = normalizeApiKeyMask(value);
  if (!masked) return <Muted />;
  return (
    <code className={cn("font-mono text-[0.8125rem]", className)} title={masked}>
      {masked}
    </code>
  );
}

export function endpointLabel(endpoint: string | undefined, t: TFunction): string {
  return isKnownEndpoint(endpoint) ? t(`endpoint.${endpoint}`) : EMPTY;
}

function ErrorCell({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  const maskText = useMaskText();
  if (record.success) return <Muted />;
  const message = maskText(record.message) || t("noErrorMessage");
  // Badge above a two-line message, so the column can narrow to fit the table on desktops. The
  // column takes the width the others leave; a long category label truncates inside its pill.
  return (
    <div className="flex min-w-36 max-w-80 flex-col items-start gap-1">
      <ErrorTypeBadge className="max-w-full" type={record.errorType} />
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="line-clamp-2 whitespace-normal text-muted-foreground text-xs leading-snug wrap-anywhere" />
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
 * Account over API key. The key has its own column from a 68rem (1088 px) container up; below it
 * the key rides here as a meta line (see ModelCell).
 */
function AccountCell({ record }: { record: RequestRecord }): JSX.Element {
  const key = normalizeApiKeyMask(record.apiKeyMasked);
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <DisplayEmail
        className="block max-w-28 @7xl/requests:max-w-56"
        email={record.email}
        id={record.accountId}
      />
      {key ? (
        <ApiKeyCode
          className="text-muted-foreground text-xs @[68rem]/requests:hidden"
          value={key}
        />
      ) : null}
    </span>
  );
}

/**
 * Model over endpoint. The endpoint has its own column from the 7xl container width up; below
 * it that column is hidden and the endpoint rides here as a meta line, like the date under the
 * time, so ten columns fit a 1440 px desktop with the sidebar open.
 */
function ModelCell({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  const endpoint = endpointLabel(record.endpoint, t);
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {record.model ? (
        // Capped on wide containers too: a long model id would push the table sideways.
        <span className="block max-w-32 truncate @7xl/requests:max-w-64" title={record.model}>
          {record.model}
        </span>
      ) : (
        <Muted />
      )}
      {endpoint === EMPTY ? null : (
        <span className="text-muted-foreground text-xs @7xl/requests:hidden">{endpoint}</span>
      )}
    </span>
  );
}

/** Time over date: two short lines instead of one long one keep the column narrow. */
function TimeCell({ ts, lang }: { ts: number; lang: Lang }): JSX.Element {
  return (
    <span className="flex flex-col gap-1" title={formatDateTime(ts, lang)}>
      <span>{formatTime(ts, lang)}</span>
      <span className="text-muted-foreground text-xs">{formatRowDate(ts, lang)}</span>
    </span>
  );
}

// Tighter cell padding than the table default, so the ten columns fit a 1440 px desktop with
// the sidebar open (eight from a 1280 px one, see AccountCell and ModelCell); wide containers get
// the default padding back.
const COMPACT_PADDING = "px-2 @7xl/requests:px-2.5";

function withCompactPadding(
  columns: DataTableColumn<RequestRecord>[],
): DataTableColumn<RequestRecord>[] {
  return columns.map((column) => ({
    ...column,
    className: cn(COMPACT_PADDING, column.className),
    headerClassName: cn(COMPACT_PADDING, column.headerClassName),
  }));
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
          className: "tabular-nums",
          cell: (row) => <TimeCell lang={lang} ts={row.ts} />,
        },
        {
          id: "status",
          header: t("status"),
          sortable: true,
          cell: (row) => <StatusBadge record={row} />,
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
          // Below a 68rem container the key shows under the account instead.
          className: "hidden @[68rem]/requests:table-cell",
          headerClassName: "hidden @[68rem]/requests:table-cell",
          cell: (row) => <ApiKeyCode className="text-xs" value={row.apiKeyMasked} />,
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
          // The breakdown line wraps instead of widening the table past the content column.
          className: "whitespace-normal",
          cell: (row) => (
            <TokenCell
              cacheReadTokens={row.cacheReadTokens}
              cacheWriteTokens={row.cacheWriteTokens}
              // A lower floor than the default 192 px: the breakdown wraps to two lines here.
              detailClassName="min-w-40"
              inTokens={row.inTokens}
              outTokens={row.outTokens}
            />
          ),
        },
        {
          id: "credits",
          header: t("credits"),
          sortable: true,
          align: "end",
          className: "tabular-nums",
          cell: (row) => <CreditAmount value={row.credits} />,
        },
        {
          id: "duration",
          header: t("duration"),
          sortable: true,
          align: "end",
          className: "tabular-nums",
          cell: (row) => formatDurationMs(row.durationMs, Boolean(row.endpoint)),
        },
        {
          id: "error",
          header: t("error"),
          cell: (row) => <ErrorCell record={row} />,
        },
      ]),
    [t, lang],
  );
}

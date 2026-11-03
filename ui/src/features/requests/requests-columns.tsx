import { type JSX, useMemo } from "react";
import type { DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { TokenCell } from "@/components/shared/token-cell";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatCredits, formatDateTime, formatDurationMs } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ErrorTypeBadge } from "./error-type-badge";
import { isKnownEndpoint, normalizeApiKeyMask } from "./request-model";

function Muted({ children = EMPTY }: { children?: string }): JSX.Element {
  return <span className="text-muted-foreground">{children}</span>;
}

export function StatusBadge({ record }: { record: RequestRecord }): JSX.Element {
  const { t } = useT("requests");
  if (record.success) return <Badge variant="success">{t("ok")}</Badge>;
  return (
    <Badge variant="error">
      {t("fail")}
      {record.status ? ` ${record.status}` : ""}
    </Badge>
  );
}

export function ApiKeyCode({ value }: { value?: string }): JSX.Element {
  const masked = normalizeApiKeyMask(value);
  if (!masked) return <Muted />;
  return (
    <code className="font-mono text-[0.8125rem]" title={masked}>
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
  return (
    <div className="flex min-w-0 max-w-80 items-center gap-2">
      <ErrorTypeBadge type={record.errorType} />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate text-muted-foreground" />}>
          {message}
        </TooltipTrigger>
        <TooltipPopup className="max-w-sm whitespace-pre-wrap break-words">{message}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The ten Requests columns; ids match the server sort names where a column sorts. */
export function useRequestColumns(): DataTableColumn<RequestRecord>[] {
  const { t, lang } = useT("requests");
  return useMemo<DataTableColumn<RequestRecord>[]>(
    () => [
      {
        id: "time",
        header: t("time"),
        sortable: true,
        sticky: true,
        className: "tabular-nums",
        cell: (row) => formatDateTime(row.ts, lang),
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
        cell: (row) => (
          <DisplayEmail className="block max-w-56" email={row.email} id={row.accountId} />
        ),
      },
      {
        id: "api_key",
        header: t("apiKey"),
        sortable: true,
        cell: (row) => <ApiKeyCode value={row.apiKeyMasked} />,
      },
      {
        id: "endpoint",
        header: t("endpoint"),
        cell: (row) => {
          const label = endpointLabel(row.endpoint, t);
          return label === EMPTY ? <Muted /> : label;
        },
      },
      {
        id: "model",
        header: t("model"),
        sortable: true,
        cell: (row) => (row.model ? row.model : <Muted />),
      },
      {
        id: "tokens",
        header: t("tokens"),
        sortable: true,
        cell: (row) => (
          <TokenCell
            cacheReadTokens={row.cacheReadTokens}
            cacheWriteTokens={row.cacheWriteTokens}
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
        cell: (row) => formatCredits(row.credits),
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
    ],
    [t, lang],
  );
}

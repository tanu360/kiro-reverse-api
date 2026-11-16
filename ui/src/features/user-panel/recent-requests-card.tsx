import {
  CircleCheckIcon,
  CircleXIcon,
  InboxIcon,
  ListChecksIcon,
  SearchXIcon,
} from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type JSX, useMemo, useState } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard } from "@/components/shared/list-card";
import { SectionCard } from "@/components/shared/section-card";
import { StatusDot } from "@/components/shared/status-dot";
import { StatusTabs } from "@/components/shared/table-toolbar";
import { TokenCell } from "@/components/shared/token-cell";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorTypeLabel } from "@/features/requests/error-type-badge";
import { formatRowDate } from "@/features/requests/request-model";
import { endpointLabel } from "@/features/requests/requests-columns";
import { type UserRequest, type UserRequestStatus, userRequestsQuery } from "@/lib/api/user-panel";
import {
  EMPTY,
  formatCompact,
  formatCredits,
  formatDurationMs,
  formatNumber,
  formatTime,
  unixToDate,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The Requests page's page sizes; ten rows keep the card short by default. */
const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;

function Muted(): JSX.Element {
  return <span className="text-muted-foreground">{EMPTY}</span>;
}

function rowId(row: UserRequest, index: number): string {
  // The server sends no log row ID (its gaps would show other keys' traffic); the request ID,
  // else the time and place, tells rows apart.
  return row.requestId || `${row.ts}-${index}`;
}

/** Time over date, as the Requests table; `inline` puts both on one line (a card's title). */
function TimeCell({ ts, lang, inline = false }: { ts: number; lang: Lang; inline?: boolean }) {
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
 * The Requests table's status: a success is quiet (a green dot and a muted label), a failure is
 * the red pill with the HTTP status, its error category under it.
 */
function StatusCell({ row, stacked = true }: { row: UserRequest; stacked?: boolean }) {
  const { t } = useT("user-panel");
  if (row.success) {
    return (
      <span className="inline-flex h-6 shrink-0 items-center gap-2 font-medium text-muted-foreground text-xs">
        <StatusDot tone="success" />
        {t("requests.success")}
      </span>
    );
  }
  const badge = (
    <Badge icon={CircleXIcon} tone="destructive">
      {t("requests.failed")}
      {row.status ? ` ${row.status}` : ""}
    </Badge>
  );
  if (!stacked) return badge;
  return (
    <span className="flex flex-col items-start gap-1">
      {badge}
      <ErrorTypeLabel
        className="max-w-36 text-meta text-muted-foreground"
        type={row.errorType || undefined}
      />
    </span>
  );
}

/** Model over endpoint, as the Requests table below its widest step. */
function ModelCell({ row }: { row: UserRequest }): JSX.Element {
  const { t } = useT("requests");
  const endpoint = endpointLabel(row.endpoint || undefined, t);
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {row.model ? <TruncatedText className="max-w-56">{row.model}</TruncatedText> : <Muted />}
      {endpoint === EMPTY ? null : (
        <span className="text-meta text-muted-foreground">{endpoint}</span>
      )}
    </span>
  );
}

/** A request as a list row on a narrow card: time and status, the model, then the figures. */
function RequestRow({ row }: { row: UserRequest }): JSX.Element {
  const { t, lang } = useT("user-panel");
  const { t: tr } = useT("requests");
  const endpoint = endpointLabel(row.endpoint || undefined, tr);
  const failed = !row.success;
  const total = row.inTokens + row.outTokens;
  const duration = formatDurationMs(row.durationMs, Boolean(row.endpoint), lang);
  const figures = [
    failed && total === 0
      ? null
      : t("requests.cardTokens", { count: total, value: formatCompact(total, lang) }),
    failed && row.credits === 0
      ? null
      : t("requests.cardCredits", { value: formatCredits(row.credits, 2, lang) }),
    duration === EMPTY ? null : duration,
  ].filter((part): part is string => part !== null);
  return (
    <ListCard
      badge={<StatusCell row={row} stacked={false} />}
      title={<TimeCell inline lang={lang} ts={row.ts} />}
      variant="row"
    >
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        {row.model ? <span className="min-w-0 truncate">{row.model}</span> : <Muted />}
        {endpoint === EMPTY ? null : (
          <span className="shrink-0 text-meta text-muted-foreground">{endpoint}</span>
        )}
      </div>
      {figures.length > 0 ? (
        <p className="truncate text-meta text-muted-foreground tabular-nums">
          {figures.join(" · ")}
        </p>
      ) : null}
      {failed && row.errorType ? (
        <ErrorTypeLabel className="text-meta" type={row.errorType} />
      ) : null}
    </ListCard>
  );
}

function useColumns(): DataTableColumn<UserRequest>[] {
  const { t, lang } = useT("user-panel");
  return useMemo<DataTableColumn<UserRequest>[]>(
    () => [
      {
        id: "time",
        header: t("requests.time"),
        width: "6.5rem",
        cell: (row) => <TimeCell lang={lang} ts={row.ts} />,
      },
      {
        id: "status",
        header: t("requests.status"),
        width: "10rem",
        cell: (row) => <StatusCell row={row} />,
      },
      {
        id: "model",
        header: t("requests.model"),
        // Takes the width the figures leave, so the token column hugs its two lines.
        className: "w-full",
        headerClassName: "w-full",
        cell: (row) => <ModelCell row={row} />,
      },
      {
        id: "tokens",
        header: t("requests.tokens"),
        cell: (row) => (
          <TokenCell
            cacheReadTokens={row.cacheReadTokens}
            cacheWriteTokens={row.cacheWriteTokens}
            inTokens={row.inTokens}
            muteZero={!row.success}
            outTokens={row.outTokens}
          />
        ),
      },
      {
        id: "credits",
        header: t("requests.credits"),
        align: "end",
        width: "6rem",
        cell: (row) =>
          !row.success && row.credits === 0 ? <Muted /> : <CreditAmount value={row.credits} />,
      },
      {
        id: "duration",
        header: t("requests.duration"),
        align: "end",
        width: "6.5rem",
        cell: (row) => (
          <span className="tabular-nums">
            {formatDurationMs(row.durationMs, Boolean(row.endpoint), lang)}
          </span>
        ),
      },
    ],
    [t, lang],
  );
}

/**
 * The key's own requests, newest first, in the Requests page's table: status tabs (All,
 * Succeeded, Failed), the rows (time, status, model, tokens, credits, duration; a row per request
 * below a 42rem card), and the pager with the page size in the footer.
 */
export function RecentRequestsCard(): JSX.Element {
  const { t, lang } = useT("user-panel");
  const [status, setStatus] = useState<UserRequestStatus>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const query = useQuery({
    ...userRequestsQuery({ page, pageSize, status }),
    placeholderData: keepPreviousData,
  });
  const columns = useColumns();
  const data = query.data;
  const rows = data?.requests ?? [];
  const total = data?.total ?? 0;
  const shownPage = data?.page ?? page;
  const shownSize = data?.pageSize ?? pageSize;
  const outOfRange = data !== undefined && rows.length === 0 && total > 0 && shownPage > 1;
  const filtered = status !== "all";

  const tabs = [
    { value: "all", label: t("requests.all"), icon: ListChecksIcon },
    { value: "success", label: t("requests.success"), icon: CircleCheckIcon },
    { value: "error", label: t("requests.failed"), icon: CircleXIcon },
  ] as const;

  let emptyState: JSX.Element;
  if (outOfRange) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={() => setPage(1)} size="sm" variant="secondary">
            {t("requests.firstPage")}
          </Button>
        }
        description={t("requests.outOfRangeBody")}
        icon={InboxIcon}
        title={t("requests.outOfRangeTitle")}
        variant="compact"
      />
    );
  } else if (filtered) {
    emptyState = (
      <EmptyState
        action={
          <Button
            onClick={() => {
              setStatus("all");
              setPage(1);
            }}
            size="sm"
            variant="secondary"
          >
            {t("requests.showAll")}
          </Button>
        }
        icon={SearchXIcon}
        title={t(status === "success" ? "requests.noSucceeded" : "requests.noFailed")}
        variant="compact"
      />
    );
  } else {
    emptyState = (
      <EmptyState
        description={t("requests.emptyBody")}
        icon={InboxIcon}
        title={t("requests.emptyTitle")}
        variant="compact"
      />
    );
  }

  const fatalError = query.isError && !data;
  // As on the Requests page: nothing to page or resize while the list fits the smallest page.
  const showTabs = data === undefined || total > 0 || filtered;
  const showPager = data !== undefined && total > PAGE_SIZES[0] && !outOfRange;

  return (
    <SectionCard
      // Clips the last row's hover tint to the card's rounded corners.
      className="overflow-hidden"
      description={t("requests.description")}
      descriptionVariant="inline"
      footer={
        showPager ? (
          <DataTablePagination
            onPageChange={setPage}
            onPageSizeChange={(next) => {
              setPageSize(next);
              setPage(1);
            }}
            page={shownPage}
            pageSize={shownSize}
            pageSizeOptions={[...PAGE_SIZES]}
            total={total}
          />
        ) : undefined
      }
      icon={ListChecksIcon}
      id="user-requests"
      meta={data ? t("requests.count", { count: total, n: formatNumber(total, lang) }) : undefined}
      slim
      title={t("requests.title")}
    >
      {/* The Requests page's status tabs; the page size sits with the pager in the footer. Like
          there, they wait for the first request: a filter cannot narrow an empty list. */}
      {showTabs ? (
        <div className="min-w-0 px-4 py-3 sm:px-6" data-slot="requests-toolbar">
          <StatusTabs<UserRequestStatus>
            label={t("requests.filter")}
            loading={false}
            onValueChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
            tabs={tabs}
            value={status}
          />
        </div>
      ) : null}
      <div className="min-w-0">
        {fatalError ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            title={t("requests.loadFailed")}
          />
        ) : (
          <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")}>
            <DataTable<UserRequest>
              caption={t("requests.caption")}
              cardLayout="divided"
              cardsBelow="2xl"
              columns={columns}
              data={rows}
              emptyState={emptyState}
              filtered={filtered}
              getRowId={rowId}
              inset
              loading={!data && query.isPending}
              pageSize={shownSize}
              renderCard={(row) => <RequestRow row={row} />}
            />
          </div>
        )}
      </div>
    </SectionCard>
  );
}

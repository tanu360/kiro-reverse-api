import { InboxIcon, SearchXIcon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type JSX, memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableSort } from "@/components/shared/data-table";
import { DataTableCard } from "@/components/shared/data-table-card";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Button } from "@/components/ui/button";
import {
  type RequestSheetHandle,
  SteppedRequestSheet,
} from "@/features/requests/request-detail-sheet";
import { defaultSortDesc, PAGE_SIZES } from "@/features/requests/request-model";
import {
  RequestCard,
  useRequestColumns,
  useRequestSummary,
} from "@/features/requests/requests-columns";
import { RequestsToolbar } from "@/features/requests/requests-toolbar";
import type { RequestRecord } from "@/lib/api/types";
import {
  USER_REQUEST_SORTS,
  type UserRequest,
  type UserRequestSort,
  userRequestsQuery,
} from "@/lib/api/user-panel";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The Requests page's smallest page: the card stays short on a page of cards. */
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];
const DEFAULT_SORT: UserRequestSort = "time";

/** The Requests toolbar's status: undefined is All. */
type Status = "success" | "failed" | undefined;

/**
 * What a key holder sees, as the shared Requests pieces take it: no account, key or message, and
 * the detail columns (cache hit, speed, request ID), which their room allows. The detail sheet
 * reads the same options: no account, key, conversation, attempts chain or message, but the
 * caller, speed, tries and exact figures.
 */
const HOLDER_VIEW = { accounts: false, messages: false, details: true } as const;

function isUserSort(value: string): value is UserRequestSort {
  return (USER_REQUEST_SORTS as readonly string[]).includes(value);
}

/**
 * A holder's row in the admin row type; the fields a holder never gets are empty, and the
 * columns are told not to show them (HOLDER_VIEW).
 */
function toRecord(row: UserRequest): RequestRecord {
  return {
    ts: row.ts,
    accountId: "",
    apiKeyId: "",
    apiKeyMasked: "",
    email: "",
    model: row.model,
    inTokens: row.inTokens,
    outTokens: row.outTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    credits: row.credits,
    success: row.success,
    status: row.status,
    message: "",
    endpoint: row.endpoint || undefined,
    client: row.client || undefined,
    durationMs: row.durationMs,
    errorType: row.errorType || undefined,
    requestId: row.requestId || undefined,
    tries: row.tries,
  };
}

function rowId(record: RequestRecord, index: number): string {
  // The server sends no log row ID (its gaps would show other keys' traffic); the request ID,
  // else the time and place, tells rows apart.
  return record.requestId ?? `${record.ts}-${index}`;
}

/**
 * The key's own requests, composed as the Requests page composes them: DataTableCard with the
 * Requests toolbar (status tabs with counts, sort, Rows; no search), the Requests columns
 * without Account, API key and error messages but with the detail columns (a row per request
 * below a 56rem card, where the ten columns stop fitting), and the pager under the card. A row
 * opens the Requests detail sheet as there, stepping through the page's rows, without the
 * admin's actions (Open account, Conversation, Replay, Copy as JSON): they read the admin API.
 * Memoised: the panel renders again on each key poll, which changes nothing here.
 */
export const RecentRequestsCard = memo(function RecentRequestsCard(): JSX.Element {
  const { t } = useT("user-panel");
  const { t: tr, lang } = useT("requests");
  const requestSummary = useRequestSummary(HOLDER_VIEW.accounts);
  const headingId = useId();
  const [status, setStatus] = useState<Status>(undefined);
  const [sort, setSort] = useState<UserRequestSort>(DEFAULT_SORT);
  const [desc, setDesc] = useState(defaultSortDesc(DEFAULT_SORT));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const query = useQuery({
    ...userRequestsQuery({
      page,
      pageSize,
      status: status === "failed" ? "error" : (status ?? "all"),
      sort,
      order: desc ? "desc" : "asc",
    }),
    placeholderData: keepPreviousData,
  });
  const columns = useRequestColumns(HOLDER_VIEW);
  // The sheet keeps the open row, so stepping through it never renders this card or its table.
  const sheet = useRef<RequestSheetHandle>(null);

  const { data, error, isError } = query;
  const hasData = data !== undefined;
  const rows = useMemo(() => (data?.requests ?? []).map(toRecord), [data]);
  // Stable, so the table's memoized rows and cards keep their render across this card's renders.
  const openRow = useCallback((row: RequestRecord) => sheet.current?.open(row), []);
  const renderCard = useCallback(
    (row: RequestRecord) => (
      <RequestCard onOpen={() => openRow(row)} record={row} {...HOLDER_VIEW} />
    ),
    [openRow],
  );
  // The server echoes the normalized paging values; they win over the local state.
  const shownPage = data?.page ?? page;
  const shownSize = data?.pageSize ?? pageSize;
  const total = data?.total ?? 0;
  const filtered = status !== undefined;
  const outOfRange = hasData && rows.length === 0 && total > 0 && shownPage > 1;
  const counts = data?.counts
    ? { success: data.counts.succeeded, failed: data.counts.failed }
    : undefined;

  const changeSort = (next: string, nextDesc: boolean) => {
    if (!isUserSort(next)) return;
    setSort(next);
    setDesc(nextDesc);
    setPage(1);
  };
  const clearFilters = () => {
    setStatus(undefined);
    setPage(1);
  };
  const tableSort: DataTableSort = { id: sort, desc };

  let emptyState: JSX.Element;
  if (outOfRange) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={() => setPage(1)} size="sm" variant="secondary">
            {tr("outOfRange.action")}
          </Button>
        }
        description={tr("outOfRange.body")}
        icon={InboxIcon}
        title={tr("outOfRange.title")}
        variant="compact"
      />
    );
  } else if (filtered) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={clearFilters} size="sm" variant="secondary">
            {tr("common:actions.clearFilters")}
          </Button>
        }
        // No "change the search" body: a holder has only the status tabs.
        icon={SearchXIcon}
        title={tr("common:state.noMatches")}
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

  const fatalError = isError && !hasData;
  // The status filter can't narrow an empty log, so it waits for the first request.
  const showFilters = !hasData || total > 0 || filtered;
  // Nothing to page through when the list fits the smallest page, is out of range or failed.
  const showPager = hasData && total > PAGE_SIZES[0] && !outOfRange && !fatalError;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 scroll-mt-20 flex-col gap-4"
      id="user-requests"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="font-semibold text-heading leading-6" id={headingId}>
          {t("requests.title")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("requests.description")}</p>
      </div>
      {/* The container the toolbar and column widths respond to. */}
      <DataTableCard
        className="@container/requests"
        toolbar={
          showFilters ? (
            <RequestsToolbar
              counts={counts}
              countsLoading={!hasData && query.isPending}
              desc={desc}
              onPageSizeChange={(next) => {
                if ((PAGE_SIZES as readonly number[]).includes(next)) {
                  setPageSize(next);
                  setPage(1);
                }
              }}
              onSortChange={changeSort}
              onStatusChange={(next) => {
                setStatus(next);
                setPage(1);
              }}
              pageSize={shownSize}
              searchable={false}
              sort={sort}
              sorts={USER_REQUEST_SORTS}
              status={status}
            />
          ) : undefined
        }
      >
        {fatalError ? (
          <ErrorState
            error={error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            title={tr("loadError")}
          />
        ) : (
          <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")}>
            <DataTable<RequestRecord>
              caption={t("requests.caption")}
              cardLayout="divided"
              // Each fetch renders the rows again, so their ages read the clock afresh.
              refreshKey={query.dataUpdatedAt}
              cardsBelow="4xl"
              columns={columns}
              data={rows}
              defaultSortDesc={defaultSortDesc}
              emptyState={emptyState}
              filtered={filtered}
              getRowId={rowId}
              loading={!hasData && query.isPending}
              onRowClick={openRow}
              onSortChange={(next) => changeSort(next.id, next.desc)}
              pageSize={shownSize}
              rowDescription={requestSummary}
              rowLabel={(row) => tr("detail.open", { time: formatDateTime(row.ts, lang) })}
              renderCard={renderCard}
              sort={tableSort}
            />
          </div>
        )}
      </DataTableCard>
      {/* The pager sits under the card, as on Requests; the page size is the toolbar's Rows. */}
      {showPager ? (
        <DataTablePagination
          onPageChange={setPage}
          page={shownPage}
          pageSize={shownSize}
          total={total}
        />
      ) : null}
      {/* A refetch keeps the open request by its key; one that left the page stays open, unstepped. */}
      <SteppedRequestSheet
        {...HOLDER_VIEW}
        actions={false}
        getKey={rowId}
        ref={sheet}
        rows={rows}
      />
    </section>
  );
});

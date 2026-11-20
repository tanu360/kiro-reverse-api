import { BubbleChatIcon, InboxIcon, InfoIcon, SearchXIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionError } from "@/components/shared/action-error";
import { DataTable, type DataTableSort } from "@/components/shared/data-table";
import { DataTableCard } from "@/components/shared/data-table-card";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { recentRequestsQuery, requestCountsQuery } from "@/lib/api/requests";
import type { RequestRecord } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RequestSort, RequestsSearch } from "@/routes/-search";
import { shortConversationId } from "./conversation-sheet";
import { type RequestSheetHandle, SteppedRequestSheet } from "./request-detail-sheet";
import {
  cleanSearch,
  DEFAULT_ORDER,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  defaultSortDesc,
  hasFilters,
  PAGE_SIZES,
  type PageSize,
  rowKey,
  toQueryParams,
} from "./request-model";
import { RequestCard, useRequestColumns, useRequestSummary } from "./requests-columns";
import { RequestsToolbar } from "./requests-toolbar";

export function RequestsPage(): JSX.Element {
  const { t, lang } = useT("requests");
  const requestSummary = useRequestSummary();
  const urlSearch = useSearch({ from: "/_app/requests" });
  const navigate = useNavigate({ from: "/requests" });
  // The search text lives in the page, never in the URL: a client key typed or pasted into the
  // box (it also matches the full key) must not reach the address bar or the browser history,
  // at any length or with any prefix. The status, sort and paging stay in the URL.
  const [searchText, setSearchText] = useState(() => urlSearch.search?.trim() ?? "");
  const search = useMemo<RequestsSearch>(
    () => ({ ...urlSearch, search: searchText || undefined }),
    [urlSearch, searchText],
  );
  const params = useMemo(() => toQueryParams(search, lang), [search, lang]);
  const query = useQuery(recentRequestsQuery(params));
  const countsQuery = useQuery(requestCountsQuery());
  const columns = useRequestColumns();
  // The sheet keeps the open row, so stepping through it never renders this page or its table.
  const sheet = useRef<RequestSheetHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const updateSearch = useCallback(
    (patch: RequestsSearch, options: { replace?: boolean } = {}) => {
      void navigate({
        search: (prev) => cleanSearch({ ...prev, ...patch }),
        replace: options.replace,
      });
    },
    [navigate],
  );

  // A ?search= link (a bookmark from an older version, a shared link) fills the box once and
  // leaves the URL at once, replacing its history entry.
  useEffect(() => {
    if (urlSearch.search === undefined) return;
    setSearchText(urlSearch.search.trim());
    updateSearch({ search: undefined }, { replace: true });
  }, [urlSearch.search, updateSearch]);

  // A failed refetch keeps the rows on screen and says why in one line above them, until a
  // fetch succeeds or it is closed (a later failure shows it again).
  const { data, error, errorUpdatedAt, isError } = query;
  const hasData = data !== undefined;
  const [closedAt, setClosedAt] = useState(0);
  const refetchFailed = isError && hasData && errorUpdatedAt !== closedAt;

  const rows = data?.requests ?? [];
  // The server echoes the normalized paging values; they win over the URL (gotcha 8).
  const page = data?.page ?? params.page ?? DEFAULT_PAGE;
  const pageSize = data?.pageSize ?? params.pageSize ?? DEFAULT_PAGE_SIZE;
  const total = data?.total ?? 0;
  const filtered = hasFilters(search);
  const outOfRange = hasData && rows.length === 0 && total > 0 && page > 1;

  // Stable, so the table's memoized rows and cards keep their render across this page's renders.
  const openRow = useCallback((row: RequestRecord) => sheet.current?.open(row), []);
  const renderCard = useCallback(
    (row: RequestRecord) => <RequestCard onOpen={() => openRow(row)} record={row} />,
    [openRow],
  );
  const showConversation = useCallback(
    (conversation: string) => updateSearch({ conversation, page: undefined }),
    [updateSearch],
  );

  const sort: DataTableSort = {
    id: params.sort ?? DEFAULT_SORT,
    desc: (params.order ?? DEFAULT_ORDER) === "desc",
  };
  const setSort = (next: RequestSort, desc: boolean) =>
    updateSearch({ sort: next, order: desc ? "desc" : "asc", page: undefined });

  // Clear filters, Show all and the out-of-range action remove themselves when pressed: focus
  // moves to a status tab, which stays (All, the first, once the status is cleared), not the page.
  // Says whether there was a tab to focus.
  const focusStatusTab = (which: "first" | "selected"): boolean => {
    const tab = which === "first" ? '[role="tab"]' : '[role="tab"][aria-selected="true"]';
    const target = bodyRef.current?.querySelector<HTMLElement>(
      `[data-slot="requests-toolbar"] ${tab}`,
    );
    target?.focus();
    return Boolean(target);
  };

  const clearFilters = () => {
    setSearchText("");
    updateSearch({ status: undefined, conversation: undefined, page: undefined });
    focusStatusTab("first");
  };

  let emptyState: JSX.Element;
  if (outOfRange) {
    emptyState = (
      <EmptyState
        action={
          <Button
            onClick={() => {
              updateSearch({ page: undefined });
              focusStatusTab("selected");
            }}
            size="sm"
            variant="secondary"
          >
            {t("outOfRange.action")}
          </Button>
        }
        description={t("outOfRange.body")}
        icon={InboxIcon}
        title={t("outOfRange.title")}
        variant="compact"
      />
    );
  } else if (filtered) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={clearFilters} size="sm" variant="secondary">
            {t("common:actions.clearFilters")}
          </Button>
        }
        description={t("common:state.noMatchesBody")}
        icon={SearchXIcon}
        title={t("common:state.noMatches")}
        variant="compact"
      />
    );
  } else {
    emptyState = (
      <EmptyState
        description={t("empty.body")}
        icon={InboxIcon}
        title={t("empty.title")}
        variant="compact"
      />
    );
  }

  const fatalError = isError && !hasData;
  // Search and the status filter can't narrow an empty log, so they wait for the first request.
  // Kept while the previous filter's rows stand in, so clearing a filter that matched nothing
  // does not drop the toolbar (and the focus moved to its tabs) until the new rows arrive.
  const showFilters = !hasData || total > 0 || filtered || query.isPlaceholderData;
  const memoryNote =
    data?.persistent === false ? (
      <Alert role="note" size="sm" variant="info">
        <HugeiconsIcon icon={InfoIcon} aria-hidden="true" />
        <AlertDescription>{t("memoryNote")}</AlertDescription>
      </Alert>
    ) : null;
  // One conversation's turns: a notice says so, with the way back to every request.
  const conversationNote = search.conversation ? (
    <Alert role="status" size="sm" variant="info">
      <HugeiconsIcon icon={BubbleChatIcon} aria-hidden="true" />
      <AlertDescription>
        {t("conversation.filtered", { id: shortConversationId(search.conversation) })}
      </AlertDescription>
      <AlertAction>
        <Button
          onClick={() => {
            updateSearch({ conversation: undefined, page: undefined });
            focusStatusTab("selected");
          }}
          size="xs"
          variant="secondary"
        >
          {t("conversation.showAll")}
        </Button>
      </AlertAction>
    </Alert>
  ) : null;
  // Nothing to page through when the list fits the smallest page, is out of range or failed.
  const showPager = hasData && total > PAGE_SIZES[0] && !outOfRange && !fatalError;
  const refresh = () => {
    void query.refetch();
    void countsQuery.refetch();
  };
  // Try again and close go with the line: focus moves to the selected status tab, not the body.
  // An empty log has no tabs (showFilters): the page's Refresh, which does the same, takes it.
  const focusAfterError = () => {
    if (focusStatusTab("selected")) return;
    document
      .querySelector<HTMLElement>('[data-slot="page-header-actions"] [data-slot="refresh-button"]')
      ?.focus();
  };
  // A new element for each failure: an alert that stays up through Try again would not be read
  // out again when the retry fails too.
  const refetchError = refetchFailed ? (
    <ActionError
      error={error}
      key={errorUpdatedAt}
      onDismiss={() => {
        setClosedAt(errorUpdatedAt);
        focusAfterError();
      }}
      onRetry={() => {
        refresh();
        focusAfterError();
      }}
    />
  ) : null;

  return (
    <>
      <PageHeader
        // The first load shows the table's skeleton, so Refresh spins only over rows on screen.
        actions={
          <RefreshButton fetching={query.isFetching && !query.isPending} onRefresh={refresh} />
        }
        description={t("description")}
        title={t("title")}
      />

      <div className="flex min-w-0 flex-col gap-4" ref={bodyRef}>
        {/* The container the toolbar and column widths respond to. */}
        <DataTableCard
          className="@container/requests"
          toolbar={
            showFilters ? (
              <>
                <RequestsToolbar
                  counts={countsQuery.data}
                  countsLoading={countsQuery.isPending}
                  desc={sort.desc}
                  onClear={clearFilters}
                  onPageSizeChange={(next) => {
                    if ((PAGE_SIZES as readonly number[]).includes(next)) {
                      updateSearch({ pageSize: next as PageSize, page: undefined });
                    }
                  }}
                  onSearchChange={(text) => {
                    setSearchText(text.trim());
                    // A new search starts on page 1.
                    if (urlSearch.page !== undefined) {
                      updateSearch({ page: undefined }, { replace: true });
                    }
                  }}
                  onSortChange={setSort}
                  onStatusChange={(status) => updateSearch({ status, page: undefined })}
                  pageSize={pageSize}
                  search={search.search?.trim() ?? ""}
                  shown={hasData ? total : undefined}
                  sort={sort.id as RequestSort}
                  status={search.status}
                />
                {conversationNote}
                {memoryNote}
                {refetchError}
              </>
            ) : (
              <>
                {conversationNote}
                {memoryNote}
                {refetchError}
              </>
            )
          }
        >
          {fatalError ? (
            <ErrorState
              error={error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
              title={t("loadError")}
            />
          ) : (
            <div className={cn("transition-opacity", query.isPlaceholderData && "opacity-60")}>
              <DataTable<RequestRecord>
                caption={t("table")}
                cardLayout="divided"
                // Each fetch renders the rows again, so their ages read the clock afresh.
                refreshKey={query.dataUpdatedAt}
                cardsBelow="2xl"
                columns={columns}
                data={rows}
                defaultSortDesc={defaultSortDesc}
                emptyState={emptyState}
                filtered={filtered}
                getRowId={rowKey}
                loading={!hasData && query.isPending}
                onRowClick={openRow}
                onSortChange={(next) => setSort(next.id as RequestSort, next.desc)}
                rowDescription={requestSummary}
                rowLabel={(row) => t("detail.open", { time: formatDateTime(row.ts, lang) })}
                pageSize={pageSize}
                renderCard={renderCard}
                sort={sort}
              />
            </div>
          )}
        </DataTableCard>
        {/* The pager sits under the card, as on Accounts; the page size is the toolbar's Rows. */}
        {showPager ? (
          <DataTablePagination
            onPageChange={(next) => updateSearch({ page: next })}
            page={page}
            pageSize={pageSize}
            total={total}
          />
        ) : null}
      </div>

      <SteppedRequestSheet
        getKey={rowKey}
        onShowConversation={showConversation}
        ref={sheet}
        rows={rows}
      />
    </>
  );
}

import { BubbleChatIcon, InboxIcon, InfoIcon, SearchXIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableSort } from "@/components/shared/data-table";
import { DataTableCard } from "@/components/shared/data-table-card";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { recentRequestsQuery, requestCountsQuery } from "@/lib/api/requests";
import { errorMessage } from "@/lib/api/server-errors";
import type { RequestRecord } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { RequestSort, RequestsSearch } from "@/routes/-search";
import { shortConversationId } from "./conversation-sheet";
import { RequestDetailSheet } from "./request-detail-sheet";
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
import { RequestCard, useRequestColumns } from "./requests-columns";
import { RequestsToolbar } from "./requests-toolbar";

interface Selection {
  key: string;
  record: RequestRecord;
}

export function RequestsPage(): JSX.Element {
  const { t, lang } = useT("requests");
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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

  // A failed refetch keeps the rows on screen and reports the failure in a toast; it is the
  // page's own news, never copied into an open detail sheet.
  const { data, error, errorUpdatedAt, isError } = query;
  const hasData = data !== undefined;
  const toastedAt = useRef(0);
  useEffect(() => {
    if (!isError || !hasData || errorUpdatedAt === toastedAt.current) return;
    toastedAt.current = errorUpdatedAt;
    toast.error(errorMessage(error, t), { background: true });
  }, [isError, hasData, error, errorUpdatedAt, t]);

  const rows = data?.requests ?? [];
  const keys = useMemo(() => rows.map((row, index) => rowKey(row, index)), [rows]);
  // The server echoes the normalized paging values; they win over the URL (gotcha 8).
  const page = data?.page ?? params.page ?? DEFAULT_PAGE;
  const pageSize = data?.pageSize ?? params.pageSize ?? DEFAULT_PAGE_SIZE;
  const total = data?.total ?? 0;
  const filtered = hasFilters(search);
  const outOfRange = hasData && rows.length === 0 && total > 0 && page > 1;

  const selectedIndex = selection ? keys.indexOf(selection.key) : -1;
  const selectedRecord = selectedIndex >= 0 ? rows[selectedIndex] : (selection?.record ?? null);

  const openRow = useCallback(
    (row: RequestRecord) => {
      const index = rows.indexOf(row);
      if (index < 0) return;
      setSelection({ key: keys[index], record: row });
      setSheetOpen(true);
    },
    [rows, keys],
  );

  const stepTo = (index: number) => {
    const row = rows[index];
    if (row) setSelection({ key: keys[index], record: row });
  };

  const sort: DataTableSort = {
    id: params.sort ?? DEFAULT_SORT,
    desc: (params.order ?? DEFAULT_ORDER) === "desc",
  };
  const setSort = (next: RequestSort, desc: boolean) =>
    updateSearch({ sort: next, order: desc ? "desc" : "asc", page: undefined });

  const clearFilters = () => {
    setSearchText("");
    updateSearch({ status: undefined, conversation: undefined, page: undefined });
  };

  let emptyState: JSX.Element;
  if (outOfRange) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={() => updateSearch({ page: undefined })} size="sm" variant="secondary">
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
  const showFilters = !hasData || total > 0 || filtered;
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
          onClick={() => updateSearch({ conversation: undefined, page: undefined })}
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

  return (
    <>
      <PageHeader
        actions={<RefreshButton fetching={query.isFetching} onRefresh={refresh} />}
        description={t("description")}
        title={t("title")}
      />

      <div className="flex min-w-0 flex-col gap-4">
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
              </>
            ) : (
              <>
                {conversationNote}
                {memoryNote}
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
                pageSize={pageSize}
                renderCard={(row) => <RequestCard onOpen={() => openRow(row)} record={row} />}
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

      <RequestDetailSheet
        count={rows.length}
        onNext={
          selectedIndex >= 0 && selectedIndex < rows.length - 1
            ? () => stepTo(selectedIndex + 1)
            : undefined
        }
        onOpenChange={setSheetOpen}
        onPrevious={selectedIndex > 0 ? () => stepTo(selectedIndex - 1) : undefined}
        onShowConversation={(conversation) => {
          setSheetOpen(false);
          updateSearch({ conversation, page: undefined });
        }}
        open={sheetOpen}
        position={selectedIndex + 1}
        record={selectedRecord}
      />
    </>
  );
}

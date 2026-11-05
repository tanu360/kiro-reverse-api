import { InboxIcon, InfoIcon, SearchXIcon } from "@hugeicons/core-free-icons";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { recentRequestsQuery } from "@/lib/api/requests";
import type { RequestRecord } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { RequestSort, RequestsSearch } from "@/routes/-search";
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
  const { t } = useT("requests");
  const search = useSearch({ from: "/_app/requests" });
  const navigate = useNavigate({ from: "/requests" });
  const params = useMemo(() => toQueryParams(search), [search]);
  const query = useQuery(recentRequestsQuery(params));
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

  // A failed refetch keeps the rows on screen and reports the failure in a toast.
  const { data, error, errorUpdatedAt, isError } = query;
  const hasData = data !== undefined;
  const toastedAt = useRef(0);
  useEffect(() => {
    if (!isError || !hasData || errorUpdatedAt === toastedAt.current) return;
    toastedAt.current = errorUpdatedAt;
    toastError(error, t);
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

  const clearFilters = () =>
    updateSearch({ search: undefined, status: undefined, page: undefined });

  let emptyState: JSX.Element;
  if (outOfRange) {
    emptyState = (
      <EmptyState
        action={
          <Button onClick={() => updateSearch({ page: undefined })} size="sm" variant="outline">
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
          <Button onClick={clearFilters} size="sm" variant="outline">
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
  // Nothing to page through when the list fits the smallest page, is out of range or failed.
  const showPager = hasData && total > PAGE_SIZES[0] && !outOfRange && !fatalError;

  return (
    <>
      <PageHeader
        actions={
          <RefreshButton fetching={query.isFetching} onRefresh={() => void query.refetch()} />
        }
        description={t("description")}
        title={t("title")}
      />

      {/* The container the toolbar and column widths respond to. */}
      <DataTableCard
        className="@container/requests"
        footer={
          showPager ? (
            <DataTablePagination
              onPageChange={(next) => updateSearch({ page: next })}
              onPageSizeChange={(next) => {
                if ((PAGE_SIZES as readonly number[]).includes(next)) {
                  updateSearch({ pageSize: next as PageSize, page: undefined });
                }
              }}
              page={page}
              pageSize={pageSize}
              pageSizeOptions={[...PAGE_SIZES]}
              total={total}
            />
          ) : null
        }
        toolbar={
          showFilters ? (
            <>
              <RequestsToolbar
                onSearchChange={(text) =>
                  updateSearch({ search: text || undefined, page: undefined }, { replace: true })
                }
                onStatusChange={(status) => updateSearch({ status, page: undefined })}
                search={search.search?.trim() ?? ""}
                status={search.status}
              />
              {memoryNote}
            </>
          ) : (
            memoryNote
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
          <div
            className={cn(
              "transition-opacity",
              query.isPlaceholderData && "opacity-60 motion-reduce:transition-none",
            )}
          >
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
              onSortChange={(next) =>
                updateSearch({
                  sort: next.id as RequestSort,
                  order: next.desc ? "desc" : "asc",
                  page: undefined,
                })
              }
              pageSize={pageSize}
              renderCard={(row) => <RequestCard onOpen={() => openRow(row)} record={row} />}
              sort={sort}
            />
          </div>
        )}
      </DataTableCard>

      <RequestDetailSheet
        count={rows.length}
        onNext={
          selectedIndex >= 0 && selectedIndex < rows.length - 1
            ? () => stepTo(selectedIndex + 1)
            : undefined
        }
        onOpenChange={setSheetOpen}
        onPrevious={selectedIndex > 0 ? () => stepTo(selectedIndex - 1) : undefined}
        open={sheetOpen}
        position={selectedIndex + 1}
        record={selectedRecord}
      />
    </>
  );
}

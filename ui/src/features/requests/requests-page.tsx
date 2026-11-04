import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { InboxIcon, InfoIcon, RotateCwIcon, SearchXIcon } from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableSort } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  rowKey,
  toQueryParams,
} from "./request-model";
import { useRequestColumns } from "./requests-columns";
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

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            variant="outline"
          >
            <RotateCwIcon
              aria-hidden="true"
              className={cn(query.isFetching && "motion-safe:animate-spin")}
            />
            {t("common:actions.refresh")}
          </Button>
        }
        title={t("title")}
      />

      {/* The container the toolbar and column widths respond to. */}
      <Card className="@container/requests min-w-0 gap-0 overflow-hidden">
        <div className="flex flex-col gap-3 border-border/50 border-b p-3 sm:p-4">
          <RequestsToolbar
            onPageSizeChange={(next) => updateSearch({ pageSize: next, page: undefined })}
            onSearchChange={(text) =>
              updateSearch({ search: text || undefined, page: undefined }, { replace: true })
            }
            onStatusChange={(status) => updateSearch({ status, page: undefined })}
            pageSize={params.pageSize ?? DEFAULT_PAGE_SIZE}
            search={search.search?.trim() ?? ""}
            status={search.status}
          />
          {data?.persistent === false ? (
            <p className="flex items-start gap-2 text-muted-foreground text-sm">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t("memoryNote")}
            </p>
          ) : null}
        </div>

        {fatalError ? (
          <ErrorState error={error} onRetry={() => void query.refetch()} />
        ) : (
          <div
            className={cn(
              "transition-opacity",
              query.isPlaceholderData && "opacity-60 motion-reduce:transition-none",
            )}
          >
            <DataTable<RequestRecord>
              caption={t("table")}
              columns={columns}
              data={rows}
              defaultSortDesc={defaultSortDesc}
              emptyState={emptyState}
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
              sort={sort}
            />
          </div>
        )}

        {/* Nothing to page through when the list is empty, filtered to nothing or out of range. */}
        {hasData && total > 0 && !outOfRange && !fatalError ? (
          <div className="border-border/50 border-t p-3 sm:px-4">
            <DataTablePagination
              onPageChange={(next) => updateSearch({ page: next })}
              page={page}
              pageSize={pageSize}
              total={total}
            />
          </div>
        ) : null}
      </Card>

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

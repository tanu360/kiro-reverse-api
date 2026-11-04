import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  DownloadIcon,
  EllipsisIcon,
  LayersIcon,
  PlusIcon,
  SearchXIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { AddAccountDialog } from "@/features/add-account/add-account-dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { accountsQuery, refreshAllModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { AccountSort, AccountsSearch } from "@/routes/-search";
import { AccountDetailSheet } from "./account-detail-sheet";
import {
  type AccountFilters,
  defaultSortDesc,
  FILTER_DIMENSIONS,
  filterAccounts,
  sortAccounts,
} from "./account-model";
import { AccountsTable } from "./accounts-table";
import { AccountsToolbar } from "./accounts-toolbar";
import { BatchBar } from "./batch-bar";
import { ExportDialog } from "./export-dialog";
import { TestAccountDialog } from "./test-account-dialog";
import { useListLayout } from "./use-list-layout";

const NO_ACCOUNTS: Account[] = [];
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/** Keeps the last target after close, so a dialog's content stays during its exit animation. */
interface DialogTarget {
  id: string;
  open: boolean;
  /** Bumped on every open, so each opening starts from a fresh state. */
  session: number;
}

function useDialogTarget(): [DialogTarget | null, (id: string) => void, () => void] {
  const [target, setTarget] = useState<DialogTarget | null>(null);
  const open = useCallback(
    (id: string) =>
      setTarget((current) => ({ id, open: true, session: (current?.session ?? 0) + 1 })),
    [],
  );
  const close = useCallback(
    () => setTarget((current) => (current ? { ...current, open: false } : current)),
    [],
  );
  return [target, open, close];
}

export function AccountsPage(): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const search = useSearch({ from: "/_app/accounts" });
  const navigate = useNavigate({ from: "/accounts" });
  const confirm = useConfirm();
  const listRef = useRef<HTMLDivElement | null>(null);
  const layout = useListLayout(listRef);
  // Phones fold Export and Refresh all models into a ⋯ menu, so the header fits 360 px.
  const isPhone = useMediaQuery("max-sm");

  const query = useQuery(accountsQuery());
  const accounts = query.data ?? NO_ACCOUNTS;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [detail, openDetail, closeDetail] = useDialogTarget();
  const [test, openTest, closeTest] = useDialogTarget();

  // Drop selected ids that are gone after a refetch. The selection survives filter changes.
  useEffect(() => {
    if (!query.data) return;
    const ids = new Set(query.data.map((account) => account.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [query.data]);

  // Filter, sort and page all live in the URL, so a reload or a shared link keeps the view.
  const { q, status, plan, auth, region, enabled } = search;
  const filters = useMemo<AccountFilters>(
    () => ({ q, status, plan, auth, region, enabled }),
    [q, status, plan, auth, region, enabled],
  );
  const sort = search.sort;
  const desc = search.order ? search.order === "desc" : sort ? defaultSortDesc(sort) : false;
  // One clock per fetch, so the token-expiry status does not change between filter and sort.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt is the clock tick.
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [query.dataUpdatedAt]);
  const filtered = useMemo(
    () => filterAccounts(accounts, filters, nowSec),
    [accounts, filters, nowSec],
  );
  const sorted = useMemo(
    () => sortAccounts(filtered, sort, desc, nowSec),
    [filtered, sort, desc, nowSec],
  );
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(search.page ?? 1, pageCount);
  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const updateSearch = (patch: Partial<AccountsSearch>, replace = true) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  };
  // Any filter change starts over at page 1.
  const setFilters = (patch: Partial<AccountFilters>) =>
    updateSearch({ ...patch, page: undefined });
  const clearFilters = () =>
    setFilters(
      Object.fromEntries(
        ["q", ...FILTER_DIMENSIONS].map((key) => [key, undefined]),
      ) as Partial<AccountFilters>,
    );
  const setSort = (next: AccountSort | undefined, nextDesc: boolean) =>
    updateSearch({
      sort: next,
      order: next ? (nextDesc ? "desc" : "asc") : undefined,
      page: undefined,
    });
  const setAddOpen = (open: boolean) => updateSearch({ add: open ? true : undefined }, false);

  const onRefreshAllModels = async () => {
    const ok = await confirm({
      title: t("models.refreshAll"),
      description: t("models.confirmRefreshAll"),
      confirmLabel: t("models.refreshAll"),
    });
    if (!ok) return;
    const toastId = toast.loading(t("models.refreshing"));
    try {
      const result = await refreshAllModels();
      // `refreshed` counts models, not accounts.
      toast.update(toastId, {
        type: "success",
        title: t("models.refreshAllDone", { count: result.refreshed ?? 0 }),
      });
    } catch (error) {
      toast.update(toastId, { type: "error", title: errorMessage(error, t) });
    }
  };

  const onExport = () => {
    if (accounts.length === 0) {
      toast.warning(t("empty.title"));
      return;
    }
    setExportOpen(true);
  };

  const onTest = useCallback((account: Account) => openTest(account.id), [openTest]);
  const onDetails = useCallback((account: Account) => openDetail(account.id), [openDetail]);

  const hasFilters =
    Boolean(filters.q) || FILTER_DIMENSIONS.some((dimension) => filters[dimension] !== undefined);
  const emptyState =
    accounts.length === 0 ? (
      <EmptyState
        action={
          <Button onClick={() => setAddOpen(true)}>
            <PlusIcon aria-hidden="true" />
            {t("actions.add")}
          </Button>
        }
        description={t("empty.body")}
        icon={UsersRoundIcon}
        title={t("empty.title")}
      />
    ) : (
      <EmptyState
        action={
          hasFilters ? (
            <Button onClick={clearFilters} variant="outline">
              {tc("actions.clearFilters")}
            </Button>
          ) : undefined
        }
        description={tc("state.noMatchesBody")}
        icon={SearchXIcon}
        title={tc("state.noMatches")}
        variant="compact"
      />
    );

  const testAccount = test ? accounts.find((account) => account.id === test.id) : undefined;

  const table = (
    <AccountsTable
      accounts={pageRows}
      desc={desc}
      emptyState={emptyState}
      layout={layout}
      loading={query.isPending}
      onDetails={onDetails}
      onSelectionChange={setSelected}
      onSortChange={setSort}
      onTest={onTest}
      selected={selected}
      sort={sort}
    />
  );

  return (
    <>
      <PageHeader
        actions={
          // Quiet to loud, one height: Refresh (an icon), Refresh all models (outline), Export
          // (a purple tint) and Add account, the only solid button.
          <>
            <RefreshButton
              fetching={query.isFetching}
              onRefresh={() => void query.refetch()}
              variant="icon"
            />
            {isPhone ? (
              <Menu>
                <MenuTrigger
                  aria-label={t("actions.moreList")}
                  render={<Button size="icon" variant="quiet" />}
                >
                  <EllipsisIcon aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={onExport}>
                    <DownloadIcon aria-hidden="true" className="text-info-foreground" />
                    {t("actions.export")}
                  </MenuItem>
                  <MenuItem onClick={() => void onRefreshAllModels()}>
                    <LayersIcon aria-hidden="true" />
                    {t("models.refreshAll")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : (
              <>
                <Button onClick={() => void onRefreshAllModels()} variant="outline">
                  <LayersIcon aria-hidden="true" />
                  {t("models.refreshAll")}
                </Button>
                <Button onClick={onExport} variant="soft">
                  <DownloadIcon aria-hidden="true" />
                  {t("actions.export")}
                </Button>
              </>
            )}
            <Button onClick={() => setAddOpen(true)}>
              <PlusIcon aria-hidden="true" />
              {t("actions.add")}
            </Button>
          </>
        }
        title={t("title")}
      />

      {query.isError && !query.data ? null : (
        <AccountsToolbar
          accounts={accounts}
          desc={desc}
          filters={filters}
          loading={query.isPending}
          onClearFilters={clearFilters}
          onFiltersChange={setFilters}
          onSortChange={setSort}
          shown={sorted.length}
          sort={sort}
        />
      )}

      {/* The accounts container hides low-priority table columns on narrower lists. */}
      <div className="@container/accounts flex min-w-0 flex-col gap-4" ref={listRef}>
        {query.isError && !query.data ? (
          <Card>
            <ErrorState
              error={query.error}
              onRetry={() => void query.refetch()}
              title={t("loadError")}
            />
          </Card>
        ) : layout === "cards" ? (
          table
        ) : (
          <Card className="min-w-0 overflow-hidden py-0">{table}</Card>
        )}
        {sorted.length > PAGE_SIZES[0] ? (
          <DataTablePagination
            onPageChange={(next) => updateSearch({ page: next > 1 ? next : undefined }, false)}
            onPageSizeChange={(size) =>
              updateSearch({
                pageSize:
                  size === DEFAULT_PAGE_SIZE ? undefined : (size as AccountsSearch["pageSize"]),
                page: undefined,
              })
            }
            page={page}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZES}
            total={sorted.length}
          />
        ) : null}
        {selected.size > 0 ? (
          <BatchBar onClear={() => setSelected(new Set())} selectedIds={[...selected]} />
        ) : null}
      </div>

      {detail ? (
        <AccountDetailSheet
          accountId={detail.id}
          key={`detail-${detail.session}`}
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
          open={detail.open}
        />
      ) : null}
      {test && testAccount ? (
        <TestAccountDialog
          account={testAccount}
          key={`test-${test.session}`}
          onOpenChange={(open) => {
            if (!open) closeTest();
          }}
          open={test.open}
        />
      ) : null}
      <ExportDialog accounts={accounts} onOpenChange={setExportOpen} open={exportOpen} />
      <AddAccountDialog onOpenChange={setAddOpen} open={search.add === true} />
    </>
  );
}

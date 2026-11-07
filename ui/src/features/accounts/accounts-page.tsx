import {
  Download01Icon,
  PlusIcon,
  Refresh01Icon,
  SearchXIcon,
  UsersRoundIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { DataTableCard } from "@/components/shared/data-table-card";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { AddAccountDialog } from "@/features/add-account/add-account-dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { accountsQuery, refreshAllModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import type { AccountSort, AccountsSearch } from "@/routes/-search";
import { AccountDetailSheet } from "./account-detail-sheet";
import {
  type AccountFilters,
  defaultSortDesc,
  describeFailures,
  FILTER_DIMENSIONS,
  filterAccounts,
  sortAccounts,
} from "./account-model";
import { AccountsTable } from "./accounts-table";
import { AccountsToolbar } from "./accounts-toolbar";
import { BatchBar } from "./batch-bar";
import { ExportDialog } from "./export-dialog";
import { TestAccountDialog } from "./test-account-dialog";

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

/**
 * The time in whole seconds, read again only when `tick` changes (a fetch's `dataUpdatedAt`), so
 * everything computed from one fetch shares one clock.
 */
function useClockAt(tick: number): number {
  const [clock, setClock] = useState(() => ({ tick, nowSec: Math.floor(Date.now() / 1000) }));
  if (clock.tick === tick) return clock.nowSec;
  const next = { tick, nowSec: Math.floor(Date.now() / 1000) };
  setClock(next);
  return next.nowSec;
}

export function AccountsPage(): JSX.Element {
  const { t } = useT("accounts");
  const { t: tc } = useT();
  const search = useSearch({ from: "/_app/accounts" });
  const navigate = useNavigate({ from: "/accounts" });
  const confirm = useConfirm();
  const displayEmail = useDisplayEmail();
  const phone = useMediaQuery("max-sm");

  const query = useQuery(accountsQuery());
  const accounts = query.data ?? NO_ACCOUNTS;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // The export dialog opens on every account (header Export) or on the selection (batch bar).
  const [exportState, setExportState] = useState<{ open: boolean; ids?: string[] }>({
    open: false,
  });
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
  const nowSec = useClockAt(query.dataUpdatedAt);
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
      // `refreshed` and `failed` count accounts; `models` is the cached model count.
      const failed = result.failed ?? 0;
      const nameOf = (id: string) => {
        const account = accounts.find((item) => item.id === id);
        return account ? displayEmail(account.email, account.id) : id;
      };
      toast.update(toastId, {
        type: failed > 0 ? "warning" : "success",
        title:
          failed > 0
            ? t("models.refreshAllPartial", { count: result.models ?? 0, failed })
            : t("models.refreshAllDone", { count: result.models ?? 0 }),
        description: describeFailures(result.results, nameOf, t) || undefined,
      });
    } catch (error) {
      toast.update(toastId, { type: "error", title: errorMessage(error, t) });
    }
  };

  const onExport = (ids?: string[]) => {
    if (accounts.length === 0) {
      toast.warning(t("empty.title"));
      return;
    }
    setExportState({ open: true, ids });
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
            <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
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
            <Button onClick={clearFilters} variant="secondary">
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
  // Loaded and empty: the card holds only the empty state, and there is nothing to refresh.
  const noAccounts = !query.isPending && !query.isError && accounts.length === 0;
  const loadFailed = query.isError && !query.data;

  const onPageSizeChange = (size: number) =>
    updateSearch({
      pageSize: size === DEFAULT_PAGE_SIZE ? undefined : (size as AccountsSearch["pageSize"]),
      page: undefined,
    });

  const toolbar =
    noAccounts || loadFailed ? undefined : (
      <AccountsToolbar
        accounts={accounts}
        desc={desc}
        filters={filters}
        loading={query.isPending}
        onClearFilters={clearFilters}
        onFiltersChange={setFilters}
        onPageSizeChange={onPageSizeChange}
        onSortChange={setSort}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        shown={sorted.length}
        sort={sort}
        tabActions={
          // A quiet action at the end of the tab row: no fill and no border, the label lighting up
          // on hover; an icon button with a tooltip on phones. It waits for the list, so it never
          // exports an empty fleet.
          phone ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t("actions.export")}
                    disabled={query.isPending}
                    onClick={() => onExport()}
                    size="icon-sm"
                    variant="quiet"
                  />
                }
              >
                <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>{t("actions.export")}</TooltipPopup>
            </Tooltip>
          ) : (
            <Button
              // The label, not the invisible box, lines up with the card's content edge.
              className="-me-2.5"
              disabled={query.isPending}
              onClick={() => onExport()}
              size="sm"
              variant="quiet"
            >
              <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
              {t("actions.export")}
            </Button>
          )
        }
      />
    );

  // The pager sits under the card; the page size is the "Rows" select at the end of the filter
  // row, and a new size starts again at page 1.
  const pager =
    sorted.length > PAGE_SIZES[0] ? (
      <DataTablePagination
        onPageChange={(next) => updateSearch({ page: next > 1 ? next : undefined }, false)}
        page={page}
        pageSize={pageSize}
        total={sorted.length}
      />
    ) : null;

  return (
    <>
      <PageHeader
        actions={
          // One refresh only: Refresh models, then Add account. The list itself refetches on
          // focus and after every action, so it needs no refresh button of its own. Export sits
          // at the end of the status tab row. An empty list shows neither: its empty state
          // carries the one primary Add account, and the header text gets the full width.
          noAccounts ? undefined : (
            <>
              <Button
                aria-label={t("models.refreshAll")}
                onClick={() => void onRefreshAllModels()}
                variant="secondary"
              >
                <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
                <span className="sm:hidden">{t("models.refreshShort")}</span>
                <span className="max-sm:hidden">{t("models.refreshAll")}</span>
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
                {t("actions.add")}
              </Button>
            </>
          )
        }
        description={t("description")}
        title={t("title")}
      />

      <div className="flex min-w-0 flex-col gap-4">
        {/* The accounts container lets the toolbar give the search its own row on narrow cards. */}
        <DataTableCard className="@container/accounts" toolbar={toolbar}>
          {loadFailed ? (
            <ErrorState
              error={query.error}
              onRetry={() => void query.refetch()}
              title={t("loadError")}
            />
          ) : (
            <AccountsTable
              accounts={pageRows}
              desc={desc}
              emptyState={emptyState}
              filtered={hasFilters && accounts.length > 0}
              loading={query.isPending}
              onDetails={onDetails}
              onSelectionChange={setSelected}
              onSortChange={setSort}
              onTest={onTest}
              pageSize={pageSize}
              selected={selected}
              sort={sort}
            />
          )}
        </DataTableCard>
        {pager}
        {selected.size > 0 ? (
          <BatchBar
            accounts={accounts}
            onClear={() => setSelected(new Set())}
            onExport={() => onExport([...selected])}
            selectedIds={[...selected]}
          />
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
      <ExportDialog
        accounts={accounts}
        initialSelection={exportState.ids}
        onOpenChange={(open) => setExportState((current) => ({ ...current, open }))}
        open={exportState.open}
      />
      <AddAccountDialog onOpenChange={setAddOpen} open={search.add === true} />
    </>
  );
}

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
import {
  type JSX,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { BatchTagDialog } from "./batch-tag-dialog";
import { DuplicatesNotice } from "./duplicates-notice";
import { ExportDialog } from "./export-dialog";
import { ReloginProvider } from "./relogin-context";
import { TestAccountDialog } from "./test-account-dialog";

const NO_ACCOUNTS: Account[] = [];
const PAGE_SIZES = [10, 25, 50, 100];
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

/** The list's shown, enabled select-all checkbox (the table header's or the cards' row), if any. */
function shownSelectAll(root: HTMLElement | null): HTMLElement | null {
  const boxes = root?.querySelectorAll<HTMLElement>(
    '[data-slot="data-table"] thead [data-slot="checkbox"]:not([data-disabled]), [data-slot="data-table-select-all"] [data-slot="checkbox"]',
  );
  return (
    [...(boxes ?? [])].find(
      (box) => typeof box.checkVisibility !== "function" || box.checkVisibility(),
    ) ?? null
  );
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
  // The batch tag dialog keeps the ids it opened with, so its title holds through the close.
  const [tagState, setTagState] = useState<{ open: boolean; ids: string[] }>({
    open: false,
    ids: [],
  });
  const [detail, openDetail, closeDetail] = useDialogTarget();
  const [test, openTest, closeTest] = useDialogTarget();
  const [relogin, openRelogin, closeRelogin] = useDialogTarget();
  const listRef = useRef<HTMLDivElement | null>(null);

  // The batch bar unmounts with the selection, so focus in it (or already dropped to <body>)
  // moves to the select-all checkbox first instead of falling to <body>.
  const clearSelection = () => {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('[data-slot="batch-bar"]')) {
      shownSelectAll(listRef.current)?.focus();
    }
    setSelected(new Set());
  };

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
  const { q, status, plan, auth, region, enabled, tag } = search;
  const filters = useMemo<AccountFilters>(
    () => ({ q, status, plan, auth, region, enabled, tag }),
    [q, status, plan, auth, region, enabled, tag],
  );
  // The search field follows every key at once; the rows follow the filters (and the page, which
  // a filter change resets) at a lower priority, so typing never waits for the table.
  const listView = useMemo(() => ({ filters, page: search.page }), [filters, search.page]);
  const shownView = useDeferredValue(listView);
  const sort = search.sort;
  const desc = search.order ? search.order === "desc" : sort ? defaultSortDesc(sort) : false;
  // One clock per fetch, so the token-expiry status does not change between filter and sort.
  const nowSec = useClockAt(query.dataUpdatedAt);
  const filtered = useMemo(
    () => filterAccounts(accounts, shownView.filters, nowSec),
    [accounts, shownView.filters, nowSec],
  );
  const sorted = useMemo(
    () => sortAccounts(filtered, sort, desc, nowSec),
    [filtered, sort, desc, nowSec],
  );
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(shownView.page ?? 1, pageCount);
  const pageSlice = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );
  // A new array after each fetch (its clock moves), so every row reads the time again: a token
  // that expired turns its pill and its time left on the next refetch.
  const pageRows = pageSlice;

  // Stable callbacks (navigate is), so the memoised table and toolbar skip unrelated renders.
  const updateSearch = useCallback(
    (patch: Partial<AccountsSearch>, replace = true) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );
  // Any filter change starts over at page 1.
  const setFilters = useCallback(
    (patch: Partial<AccountFilters>) => updateSearch({ ...patch, page: undefined }),
    [updateSearch],
  );
  const clearFilters = useCallback(
    () =>
      setFilters(
        Object.fromEntries(
          ["q", ...FILTER_DIMENSIONS].map((key) => [key, undefined]),
        ) as Partial<AccountFilters>,
      ),
    [setFilters],
  );
  const setSort = useCallback(
    (next: AccountSort | undefined, nextDesc: boolean) =>
      updateSearch({
        sort: next,
        order: next ? (nextDesc ? "desc" : "asc") : undefined,
        page: undefined,
      }),
    [updateSearch],
  );
  const setAddOpen = useCallback(
    (open: boolean) => updateSearch({ add: open ? true : undefined }, false),
    [updateSearch],
  );

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

  const listEmpty = accounts.length === 0;
  const onExport = useCallback(
    (ids?: string[]) => {
      if (listEmpty) {
        toast.warning(t("export.noAccounts"));
        return;
      }
      setExportState({ open: true, ids });
    },
    [listEmpty, t],
  );
  const onExportOpenChange = useCallback(
    (open: boolean) => setExportState((current) => ({ ...current, open })),
    [],
  );

  const onTest = useCallback((account: Account) => openTest(account.id), [openTest]);
  const onDetails = useCallback((account: Account) => openDetail(account.id), [openDetail]);
  const onRelogin = useCallback((account: Account) => openRelogin(account.id), [openRelogin]);

  // The filters the rows were drawn with, so the empty state matches the rows it stands for.
  const shownFilters = shownView.filters;
  const hasFilters =
    Boolean(shownFilters.q) ||
    FILTER_DIMENSIONS.some((dimension) => shownFilters[dimension] !== undefined);
  const emptyState = useMemo(
    () =>
      listEmpty ? (
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
      ),
    [listEmpty, hasFilters, setAddOpen, clearFilters, t, tc],
  );

  const testAccount = test ? accounts.find((account) => account.id === test.id) : undefined;
  const reloginAccount = relogin
    ? accounts.find((account) => account.id === relogin.id)
    : undefined;
  // Loaded and empty: the card holds only the empty state, and there is nothing to refresh.
  const noAccounts = !query.isPending && !query.isError && accounts.length === 0;
  const loadFailed = query.isError && !query.data;

  const onPageSizeChange = useCallback(
    (size: number) =>
      updateSearch({
        pageSize: size === DEFAULT_PAGE_SIZE ? undefined : (size as AccountsSearch["pageSize"]),
        page: undefined,
      }),
    [updateSearch],
  );

  const pending = query.isPending;
  const tabActions = useMemo(
    () =>
      // A quiet action at the end of the tab row: no fill and no border, the label lighting up
      // on hover; an icon button with a tooltip on phones. It waits for the list, so it never
      // exports an empty fleet.
      phone ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={t("actions.export")}
                disabled={pending}
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
          disabled={pending}
          onClick={() => onExport()}
          size="sm"
          variant="quiet"
        >
          <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
          {t("actions.export")}
        </Button>
      ),
    [phone, pending, onExport, t],
  );

  const toolbar =
    noAccounts || loadFailed ? undefined : (
      <AccountsToolbar
        accounts={accounts}
        desc={desc}
        filters={filters}
        loading={pending}
        onClearFilters={clearFilters}
        onFiltersChange={setFilters}
        onPageSizeChange={onPageSizeChange}
        onSortChange={setSort}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        shown={sorted.length}
        sort={sort}
        tabActions={tabActions}
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
    <ReloginProvider onRelogin={onRelogin}>
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

      <div className="flex min-w-0 flex-col gap-4" ref={listRef}>
        {noAccounts ? null : <DuplicatesNotice />}
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
              filtered={hasFilters && !listEmpty}
              loading={pending}
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
            onClear={clearSelection}
            onExport={() => onExport([...selected])}
            onTags={() => setTagState({ open: true, ids: [...selected] })}
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
        onOpenChange={onExportOpenChange}
        open={exportState.open}
      />
      <BatchTagDialog
        accounts={accounts}
        ids={tagState.ids}
        // Once a run clears the selection the Tags button that opened it is gone with the bar.
        finalFocus={() =>
          listRef.current?.querySelector('[data-slot="batch-bar"]')
            ? true
            : (shownSelectAll(listRef.current) ?? true)
        }
        onDone={() => {
          setTagState((current) => ({ ...current, open: false }));
          setSelected(new Set());
        }}
        onOpenChange={(open) => setTagState((current) => ({ ...current, open }))}
        open={tagState.open}
      />
      <AddAccountDialog onOpenChange={setAddOpen} open={search.add === true} />
      {relogin && reloginAccount ? (
        <AddAccountDialog
          key={`relogin-${relogin.session}`}
          onOpenChange={(open) => {
            if (!open) closeRelogin();
          }}
          open={relogin.open}
          relogin={reloginAccount}
        />
      ) : null}
    </ReloginProvider>
  );
}

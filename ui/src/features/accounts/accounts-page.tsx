import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  DownloadIcon,
  EllipsisVerticalIcon,
  LayersIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SearchXIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { AddAccountDialog } from "@/features/add-account/add-account-dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { accountsQuery, refreshAllModels } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { AccountStatusFilter } from "@/routes/-search";
import { AccountDetailSheet } from "./account-detail-sheet";
import { filterAccounts, statusCounts } from "./account-model";
import { AccountsTable } from "./accounts-table";
import { BatchBar } from "./batch-bar";
import { ExportDialog } from "./export-dialog";
import { TestAccountDialog } from "./test-account-dialog";
import { useListLayout } from "./use-list-layout";

const NO_ACCOUNTS: Account[] = [];
const STATUS_FILTERS: readonly AccountStatusFilter[] = ["all", "enabled", "disabled", "banned"];

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
  const isPhone = useMediaQuery("max-sm");
  const confirm = useConfirm();
  const listRef = useRef<HTMLDivElement | null>(null);
  const layout = useListLayout(listRef);

  const query = useQuery(accountsQuery());
  const accounts = query.data ?? NO_ACCOUNTS;
  const status = search.status ?? "all";

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

  const filtered = useMemo(
    () => filterAccounts(accounts, search.status, search.q),
    [accounts, search.status, search.q],
  );
  const counts = useMemo(() => (query.data ? statusCounts(query.data) : null), [query.data]);

  const setSearchText = (value: string) => {
    void navigate({ search: (prev) => ({ ...prev, q: value || undefined }), replace: true });
  };
  const setStatus = (next: AccountStatusFilter) => {
    void navigate({
      search: (prev) => ({ ...prev, status: next === "all" ? undefined : next }),
      replace: true,
    });
  };
  const clearFilters = () => {
    void navigate({
      search: (prev) => ({ ...prev, status: undefined, q: undefined }),
      replace: true,
    });
  };
  const setAddOpen = (open: boolean) => {
    void navigate({ search: (prev) => ({ ...prev, add: open ? true : undefined }) });
  };

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

  const hasFilters = Boolean(search.q) || status !== "all";
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
      accounts={filtered}
      emptyState={emptyState}
      layout={layout}
      loading={query.isPending}
      onDetails={onDetails}
      onSelectionChange={setSelected}
      onTest={onTest}
      selected={selected}
    />
  );

  return (
    <>
      <PageHeader
        actions={
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-busy={query.isFetching || undefined}
                    aria-label={t("actions.refreshList")}
                    className="size-10 sm:size-8"
                    onClick={() => void query.refetch()}
                    size="icon"
                    variant="outline"
                  />
                }
              >
                <RotateCwIcon
                  aria-hidden="true"
                  className={query.isFetching ? "motion-safe:animate-spin" : undefined}
                />
              </TooltipTrigger>
              <TooltipPopup>{t("actions.refreshList")}</TooltipPopup>
            </Tooltip>
            {isPhone ? (
              // On phones the secondary actions share one menu, so Add account stays on the
              // first row next to Refresh.
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={t("actions.moreList")}
                      className="size-10"
                      size="icon"
                      variant="outline"
                    />
                  }
                >
                  <EllipsisVerticalIcon aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem className="min-h-10" onClick={onExport}>
                    <DownloadIcon aria-hidden="true" />
                    {t("actions.export")}
                  </MenuItem>
                  <MenuItem className="min-h-10" onClick={() => void onRefreshAllModels()}>
                    <LayersIcon aria-hidden="true" />
                    {t("models.refreshAll")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : (
              <>
                <Button onClick={onExport} variant="outline">
                  <DownloadIcon aria-hidden="true" />
                  {t("actions.export")}
                </Button>
                <Button onClick={() => void onRefreshAllModels()} variant="outline">
                  <LayersIcon aria-hidden="true" />
                  {t("models.refreshAll")}
                </Button>
              </>
            )}
            <Button className="max-sm:h-10" onClick={() => setAddOpen(true)}>
              <PlusIcon aria-hidden="true" />
              {t("actions.add")}
            </Button>
          </>
        }
        title={t("title")}
      />

      {/* Lays out from the page's own width (a container query), so the open sidebar counts. */}
      <div className="@container">
        <div className="flex min-w-0 flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:justify-between">
          <InputGroup className="w-full @3xl:max-w-80">
            <InputGroupInput
              aria-label={t("filter.search")}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("filter.search")}
              type="search"
              value={search.q ?? ""}
            />
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
          </InputGroup>
          <div className="-mx-4 min-w-0 overflow-x-auto px-4 md:mx-0 md:px-0">
            <SegmentedControl aria-label={t("filter.status")} role="group">
              {STATUS_FILTERS.map((value) => {
                const active = status === value;
                return (
                  <SegmentedControlItem
                    aria-pressed={active}
                    className="max-md:h-10"
                    data-pressed={active ? "" : undefined}
                    key={value}
                    onClick={() => setStatus(value)}
                  >
                    {t(`filter.${value}`)}
                    {/* No counts until the list loads: zeros would read as an empty fleet. */}
                    {counts ? (
                      <span className="text-muted-foreground tabular-nums">{counts[value]}</span>
                    ) : null}
                  </SegmentedControlItem>
                );
              })}
            </SegmentedControl>
          </div>
        </div>
      </div>

      {/* The accounts container hides low-priority table columns on narrower lists. */}
      <div className="@container/accounts flex min-w-0 flex-col gap-4 md:gap-6" ref={listRef}>
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

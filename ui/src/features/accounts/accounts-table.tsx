import { type JSX, type ReactNode, useMemo } from "react";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/shared/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { ACCOUNT_SORTS, type AccountSort } from "@/routes/-search";
import {
  AccountIdentity,
  LastUsedText,
  StatusPill,
  TokenExpiryText,
  UsageMeter,
} from "./account-cells";
import { defaultSortDesc } from "./account-model";
import { AccountRowActions, EnabledSwitch, type RowActionHandlers } from "./account-row-actions";
import type { ListLayout } from "./use-list-layout";

const SKELETON_CARDS = 4;

/**
 * Low-priority columns show only when the list is wide enough for them: Requests from 900 px,
 * Last used and Token expiry from FULL_TABLE_WIDTH (1,100 px). The `accounts` container is the
 * list wrapper in accounts-page.tsx. The detail sheet and the cards still show these values.
 */
const MEDIUM_UP = "hidden @[900px]/accounts:table-cell";
const WIDE_ONLY = "hidden @[1100px]/accounts:table-cell";

const SORTABLE = new Set<string>(ACCOUNT_SORTS);

interface AccountsTableProps extends RowActionHandlers {
  /** The rows of the current page, already filtered and sorted. */
  accounts: Account[];
  rowNumberOffset?: number;
  /** From the list container's width (see useListLayout). */
  layout: ListLayout;
  loading: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  emptyState: ReactNode;
  sort: AccountSort | undefined;
  desc: boolean;
  onSortChange: (sort: AccountSort, desc: boolean) => void;
}

/**
 * A table from the `md` width of the list up (low-priority columns only on wider lists), cards
 * below. Sorting, filtering and paging happen in the page; this renders the rows it is given.
 */
export function AccountsTable(props: AccountsTableProps): JSX.Element {
  return props.layout === "cards" ? <AccountCards {...props} /> : <AccountsDataTable {...props} />;
}

function AccountsDataTable({
  accounts,
  rowNumberOffset = 0,
  loading,
  selected,
  onSelectionChange,
  emptyState,
  onTest,
  onDetails,
  sort,
  desc,
  onSortChange,
}: AccountsTableProps): JSX.Element {
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const displayEmail = useDisplayEmail();

  const columns = useMemo<DataTableColumn<Account>[]>(
    () => [
      {
        id: "account",
        header: t("columns.account"),
        sortable: true,
        // A fixed measure, so a long address truncates (with a tooltip) instead of widening
        // the column.
        cell: (account) => <AccountIdentity account={account} className="w-52 xl:w-64" />,
      },
      {
        id: "status",
        header: t("columns.status"),
        sortable: true,
        cell: (account) => <StatusPill account={account} />,
      },
      {
        id: "usage",
        header: t("columns.usage"),
        sortable: true,
        className: "w-48",
        cell: (account) => <UsageMeter account={account} />,
      },
      {
        id: "requests",
        header: t("columns.requests"),
        sortable: true,
        className: MEDIUM_UP,
        headerClassName: MEDIUM_UP,
        align: "end",
        cell: (account) => (
          <span className="tabular-nums">{formatNumber(account.requestCount, lang)}</span>
        ),
      },
      {
        id: "lastUsed",
        header: t("columns.lastUsed"),
        sortable: true,
        className: WIDE_ONLY,
        headerClassName: WIDE_ONLY,
        cell: (account) => <LastUsedText account={account} />,
      },
      {
        id: "expiry",
        header: t("columns.expiry"),
        sortable: true,
        className: WIDE_ONLY,
        headerClassName: WIDE_ONLY,
        cell: (account) => <TokenExpiryText account={account} />,
      },
      {
        id: "enabled",
        header: t("columns.enabled"),
        cell: (account) => <EnabledSwitch account={account} />,
      },
      {
        id: "actions",
        header: <span className="sr-only">{tc("table.actions")}</span>,
        align: "end",
        // Pinned, so the row actions stay in reach if a long translation makes the table scroll.
        sticky: "end",
        cell: (account) => (
          <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} />
        ),
      },
    ],
    [t, tc, lang, onDetails, onTest],
  );

  const tableSort: DataTableSort | null = sort ? { id: sort, desc } : null;

  return (
    <DataTable
      caption={t("table.caption")}
      // Roomier rows than the shared default: two-line cells need the air.
      className="accounts-grid"
      rowNumberOffset={rowNumberOffset}
      columns={columns}
      data={accounts}
      defaultSortDesc={defaultSortDesc}
      emptyState={emptyState}
      getRowId={(account) => account.id}
      loading={loading}
      onRowClick={onDetails}
      onSortChange={(next) => {
        if (SORTABLE.has(next.id)) onSortChange(next.id as AccountSort, next.desc);
      }}
      selection={{
        selected,
        onChange: onSelectionChange,
        rowLabel: (account) => displayEmail(account.email, account.id),
      }}
      sort={tableSort}
    />
  );
}

/** Card list: one column on phones, as many 22rem columns as fit on wider lists. */
function AccountCards({
  accounts,
  loading,
  selected,
  onSelectionChange,
  emptyState,
  onTest,
  onDetails,
}: AccountsTableProps): JSX.Element {
  const { t } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const gridClass = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-2";

  if (loading && accounts.length === 0) {
    return (
      <div aria-busy="true" className={gridClass}>
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards never reorder.
          <SkeletonCard key={index} />
        ))}
      </div>
    );
  }
  if (accounts.length === 0) return <div>{emptyState}</div>;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  return (
    <ul aria-label={t("table.caption")} className={gridClass}>
      {accounts.map((account) => {
        const isSelected = selected.has(account.id);
        return (
          <li className="flex" data-state={isSelected ? "selected" : undefined} key={account.id}>
            <AccountCard
              account={account}
              onDetails={onDetails}
              onTest={onTest}
              selected={isSelected}
              selectLabel={t("selectAccount", { email: displayEmail(account.email, account.id) })}
              toggleSelected={() => toggle(account.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Same outline as a card (t3code's SettingsGroup), so the loading list reads as cards. */
function SkeletonCard(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-3">
        <Skeleton className="size-5 rounded" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <Skeleton className="h-6 w-20 rounded-full" />
      <Skeleton className="h-1 w-full rounded-full" />
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
      </div>
    </div>
  );
}

/** Card: select, identity, switch and menu; the status pill; usage; three quiet stats. */
function AccountCard({
  account,
  selected,
  toggleSelected,
  selectLabel,
  onTest,
  onDetails,
}: RowActionHandlers & {
  account: Account;
  selected: boolean;
  toggleSelected: () => void;
  selectLabel: string;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  return (
    <article
      className="flex w-full min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-3 data-selected:border-ring"
      data-selected={selected || undefined}
    >
      <div className="flex items-start gap-1">
        {/* The whole 40 px square toggles the checkbox, not only its 18 px box. */}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI control inside is the input. */}
        <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox aria-label={selectLabel} checked={selected} onCheckedChange={toggleSelected} />
        </label>
        <AccountIdentity account={account} className="flex-1 pt-2.5" />
        <span className="flex h-10 shrink-0 items-center px-1">
          <EnabledSwitch account={account} />
        </span>
        <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} variant="menu" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ps-11">
        <StatusPill account={account} />
        <UsageMeter account={account} />
      </div>
      <dl className="mt-auto grid grid-cols-3 gap-2 border-border/50 border-t ps-11 pt-3 text-xs">
        <Stat label={t("columns.requests")} value={formatNumber(account.requestCount, lang)} />
        <Stat label={t("columns.lastUsed")} value={<LastUsedText account={account} />} />
        <Stat label={t("columns.expiry")} value={<TokenExpiryText account={account} />} />
      </dl>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate tabular-nums">{value}</dd>
    </div>
  );
}

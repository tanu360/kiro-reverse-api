import { type JSX, type ReactNode, useMemo } from "react";
import {
  DataTable,
  type DataTableCardContext,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/shared/data-table";
import { ListCard, ListCardSkeleton } from "@/components/shared/list-card";
import { Checkbox } from "@/components/ui/checkbox";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { ACCOUNT_SORTS, type AccountSort } from "@/routes/-search";
import {
  AccountFlags,
  AccountIdentity,
  AuthIcon,
  accountMeta,
  authIconNamesMethod,
  hasAuthIcon,
  LastUsedText,
  StatusPill,
  TokenExpiryText,
  UsageMeter,
  useAccountName,
} from "./account-cells";
import { defaultSortDesc } from "./account-model";
import { AccountRowActions, EnabledSwitch, type RowActionHandlers } from "./account-row-actions";

/**
 * Low-priority columns show only when the table is wide enough for them: Requests from a 56rem
 * table (@4xl), Last used from 64rem (@5xl), Token expiry from 72rem (@6xl). The query container
 * is DataTable's own wrapper. The detail sheet and the cards still show these values.
 *
 * Every other column has a fixed width, set on the column so the header, the loading rows and
 * the data rows share it; Account takes the rest of the table. So the headers stay put while the
 * rows load and when a filter empties the table, and each tier leaves Account at least 15rem
 * (14rem at @3xl, under 13rem only in the 42 to 48rem band).
 */
const MEDIUM_UP = "hidden @4xl/data-table:table-cell";
const WIDE_ONLY = "hidden @5xl/data-table:table-cell";
const WIDEST_ONLY = "hidden @6xl/data-table:table-cell";
// Three icon buttons (gap-0.5) and the cell padding, at the button's fine and coarse sizes.
const ACTIONS_WIDTH = "w-32.5 pointer-coarse:w-38.5";

/** The same width classes on a column's header and cells. */
function width(classes: string): { className: string; headerClassName: string } {
  return { className: classes, headerClassName: classes };
}

const SORTABLE = new Set<string>(ACCOUNT_SORTS);

interface AccountsTableProps extends RowActionHandlers {
  /** The rows of the current page, already filtered and sorted. */
  accounts: Account[];
  loading: boolean;
  /** Rows a full page holds, for the loading placeholder. */
  pageSize: number;
  /** A search or filter is set: an empty result keeps the header. */
  filtered: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  emptyState: ReactNode;
  sort: AccountSort | undefined;
  desc: boolean;
  onSortChange: (sort: AccountSort, desc: boolean) => void;
}

/**
 * The accounts table, with comfortable two-line rows; below a 42rem table (@2xl) each row is a
 * card divided inside the surrounding card. Sorting, filtering and paging happen in the page;
 * this renders the rows it is given.
 */
export function AccountsTable({
  accounts,
  loading,
  pageSize,
  filtered,
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
  const accountName = useAccountName();

  const columns = useMemo<DataTableColumn<Account>[]>(
    () => [
      {
        id: "account",
        header: t("columns.account"),
        sortable: true,
        // The one column without a width: it takes what the others leave. The content does not
        // size it (inline-size containment), so a long address truncates (with a tooltip)
        // instead of widening the column, and loading rows measure the same as data rows.
        cell: (account) => (
          <AccountIdentity account={account} className="w-full contain-inline-size" />
        ),
      },
      {
        id: "status",
        header: t("columns.status"),
        sortable: true,
        ...width("w-36"),
        cell: (account) => <StatusPill account={account} />,
      },
      {
        id: "usage",
        header: t("columns.usage"),
        sortable: true,
        ...width("w-40"),
        cell: (account) => <UsageMeter account={account} />,
      },
      {
        id: "requests",
        header: t("columns.requests"),
        sortable: true,
        ...width(`w-24 ${MEDIUM_UP}`),
        align: "end",
        cell: (account) => formatNumber(account.requestCount, lang),
      },
      {
        id: "lastUsed",
        header: t("columns.lastUsed"),
        sortable: true,
        ...width(`w-32 ${WIDE_ONLY}`),
        cell: (account) => <LastUsedText account={account} />,
      },
      {
        id: "expiry",
        header: t("columns.expiry"),
        sortable: true,
        ...width(`w-28 ${WIDEST_ONLY}`),
        cell: (account) => <TokenExpiryText account={account} />,
      },
      {
        id: "enabled",
        header: t("columns.enabled"),
        ...width("w-20"),
        cell: (account) => <EnabledSwitch account={account} />,
      },
      {
        id: "actions",
        header: <span className="sr-only">{tc("table.actions")}</span>,
        align: "end",
        ...width(ACTIONS_WIDTH),
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
      cardLayout="divided"
      cardsBelow="2xl"
      columns={columns}
      data={accounts}
      defaultSortDesc={defaultSortDesc}
      density="comfortable"
      emptyState={emptyState}
      filtered={filtered}
      getRowId={(account) => account.id}
      inset
      loading={loading}
      onRowClick={onDetails}
      onSortChange={(next) => {
        if (SORTABLE.has(next.id)) onSortChange(next.id as AccountSort, next.desc);
      }}
      pageSize={pageSize}
      renderCard={(account, ctx) => (
        <AccountCard account={account} ctx={ctx} onDetails={onDetails} onTest={onTest} />
      )}
      // The phone loading rows take the account card's shape and height.
      renderCardSkeleton={() => <ListCardSkeleton action leading meter stats={3} variant="row" />}
      rowLabel={(account) => t("openDetails", { email: accountName(account).text })}
      selection={{
        selected,
        onChange: onSelectionChange,
        rowLabel: (account) => accountName(account).text,
      }}
      sort={tableSort}
    />
  );
}

/**
 * One account as a row of the card list: the checkbox and name with the switch and menu at the
 * end; the status pill leading the nickname, plan and sign-in line; usage across the full width;
 * three quiet stats. A tap anywhere else opens the details.
 */
function AccountCard({
  account,
  ctx,
  onTest,
  onDetails,
}: RowActionHandlers & { account: Account; ctx: DataTableCardContext }): JSX.Element {
  const { t, lang } = useT("accounts");
  const name = useAccountName()(account);
  return (
    <ListCard
      action={
        <span className="flex items-center gap-2">
          <EnabledSwitch account={account} />
          <AccountRowActions
            account={account}
            onDetails={onDetails}
            onTest={onTest}
            variant="menu"
          />
        </span>
      }
      badge={hasAuthIcon(account) ? <AuthIcon account={account} /> : undefined}
      leading={
        <Checkbox
          aria-label={t("selectAccount", { email: name.text })}
          checked={ctx.selected}
          onCheckedChange={ctx.toggleSelected}
        />
      }
      meta={
        // The status leads the meta line, so the header row leaves the name its width.
        <span className="flex min-w-0 items-center gap-2">
          <StatusPill account={account} size="sm" />
          <span className="truncate">{accountMeta(account, t, !authIconNamesMethod(account))}</span>
          <AccountFlags account={account} />
        </span>
      }
      onOpen={() => onDetails(account)}
      openLabel={t("openDetails", { email: name.text })}
      selected={ctx.selected}
      title={<span className={name.mono ? "font-mono text-meta" : undefined}>{name.text}</span>}
      variant="row"
    >
      <UsageMeter account={account} />
      <dl className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1fr)] gap-3 text-meta">
        <Stat
          label={t("columns.requests")}
          value={<span className="tabular-nums">{formatNumber(account.requestCount, lang)}</span>}
        />
        <Stat
          label={t("columns.lastUsed")}
          value={<LastUsedText account={account} style="narrow" />}
        />
        <Stat label={t("columns.expiry")} value={<TokenExpiryText account={account} />} />
      </dl>
    </ListCard>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

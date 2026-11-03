import { type JSX, type ReactNode, useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account } from "@/lib/api/types";
import { formatCompact, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import {
  AccountBadges,
  AccountIdentity,
  CreditMeters,
  HealthBadges,
  TokenExpiryText,
} from "./account-cells";
import { formatCreditAmount } from "./account-model";
import { AccountRowActions, EnabledSwitch, type RowActionHandlers } from "./account-row-actions";
import type { ListLayout } from "./use-list-layout";

const SKELETON_CARDS = 4;

interface AccountsTableProps extends RowActionHandlers {
  accounts: Account[];
  /** From the list container's width (see useListLayout). */
  layout: ListLayout;
  loading: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  emptyState: ReactNode;
}

/** A table when the list has room for every column, cards otherwise. Server order, no paging. */
export function AccountsTable(props: AccountsTableProps): JSX.Element {
  return props.layout === "cards" ? <AccountCards {...props} /> : <AccountsDataTable {...props} />;
}

function AccountsDataTable({
  accounts,
  loading,
  selected,
  onSelectionChange,
  emptyState,
  onTest,
  onDetails,
}: AccountsTableProps): JSX.Element {
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const displayEmail = useDisplayEmail();

  const columns = useMemo<DataTableColumn<Account>[]>(
    () => [
      {
        id: "account",
        header: t("columns.account"),
        cell: (account) => (
          <div className="flex min-w-56 flex-col gap-1.5">
            <AccountIdentity account={account} />
            <AccountBadges account={account} />
          </div>
        ),
      },
      {
        id: "status",
        header: t("columns.status"),
        cell: (account) => <HealthBadges account={account} />,
      },
      {
        id: "credits-plan",
        header: t("columns.planCredits"),
        // Lets a long translated header wrap instead of widening the meter column.
        headerClassName: "whitespace-normal leading-tight",
        cell: (account) => <CreditMeters account={account} compact />,
      },
      {
        id: "requests",
        header: t("columns.requests"),
        align: "end",
        cell: (account) => (
          <span className="tabular-nums">{formatNumber(account.requestCount, lang)}</span>
        ),
      },
      {
        id: "tokens",
        header: t("columns.tokens"),
        align: "end",
        cell: (account) => (
          <span className="tabular-nums">{formatCompact(account.totalTokens)}</span>
        ),
      },
      {
        id: "credits",
        header: t("columns.credits"),
        align: "end",
        cell: (account) => (
          <span className="tabular-nums">{formatCreditAmount(account.totalCredits, lang)}</span>
        ),
      },
      {
        id: "expiry",
        header: t("columns.expiry"),
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
        cell: (account) => (
          <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} />
        ),
      },
    ],
    [t, tc, lang, onDetails, onTest],
  );

  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      data={accounts}
      emptyState={emptyState}
      getRowId={(account) => account.id}
      loading={loading}
      selection={{
        selected,
        onChange: onSelectionChange,
        rowLabel: (account) => displayEmail(account.email, account.id),
      }}
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

/** Same outline as a card, so the loading list reads as cards on both themes. */
function SkeletonCard(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-3">
        <Skeleton className="size-5 rounded" />
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <Skeleton className="h-2 w-full rounded-full" />
      <div className="grid grid-cols-4 gap-2">
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
      </div>
    </div>
  );
}

/** Card: select, email, health and switch; credits; badges and stats; kebab menu. */
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
      className="flex w-full min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 data-selected:border-ring"
      data-selected={selected || undefined}
    >
      <div className="flex items-start gap-2">
        {/* The whole 40 px square toggles the checkbox, not only its 18 px box. */}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI control inside is the input. */}
        <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox aria-label={selectLabel} checked={selected} onCheckedChange={toggleSelected} />
        </label>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DisplayEmail className="block font-medium" email={account.email} id={account.id} />
          {account.nickname ? (
            <span className="truncate text-muted-foreground text-xs">{account.nickname}</span>
          ) : null}
          <HealthBadges account={account} />
        </div>
        <span className="flex h-10 shrink-0 items-center">
          <EnabledSwitch account={account} />
        </span>
        <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} variant="menu" />
      </div>
      <CreditMeters account={account} />
      <div className="mt-auto flex flex-col gap-2">
        <AccountBadges account={account} />
        <dl className="grid grid-cols-4 gap-2 text-xs">
          <Stat label={t("columns.requests")} value={formatNumber(account.requestCount, lang)} />
          <Stat label={t("columns.tokens")} value={formatCompact(account.totalTokens)} />
          <Stat
            label={t("columns.credits")}
            value={formatCreditAmount(account.totalCredits, lang)}
          />
          <Stat label={t("columns.expiry")} value={<TokenExpiryText account={account} />} />
        </dl>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}

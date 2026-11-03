import { type JSX, type ReactNode, useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { Checkbox } from "@/components/ui/checkbox";
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
import { AccountRowActions, EnabledSwitch, type RowActionHandlers } from "./account-row-actions";

/** Table from `md` up, stacked cards below it. Server order, no sorting, no pagination. */
export function AccountsTable({
  accounts,
  loading,
  selected,
  onSelectionChange,
  emptyState,
  onTest,
  onDetails,
}: RowActionHandlers & {
  accounts: Account[];
  loading: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  emptyState: ReactNode;
}): JSX.Element {
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
        cell: (account) => <CreditMeters account={account} />,
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
          <span className="tabular-nums">{Number(account.totalCredits).toFixed(1)}</span>
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
      renderMobileCard={(account, { selected: isSelected, toggleSelected }) => (
        <AccountCard
          account={account}
          onDetails={onDetails}
          onTest={onTest}
          selected={isSelected}
          selectLabel={t("selectAccount", { email: displayEmail(account.email, account.id) })}
          toggleSelected={toggleSelected}
        />
      )}
      selection={{
        selected,
        onChange: onSelectionChange,
        rowLabel: (account) => displayEmail(account.email, account.id),
      }}
    />
  );
}

/** Mobile card: select, email, health and switch; credits; badges and stats; kebab menu. */
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
      className="flex flex-col gap-3 rounded-xl border bg-card p-3 data-selected:border-ring"
      data-selected={selected || undefined}
    >
      <div className="flex items-start gap-2">
        <span className="flex size-10 shrink-0 items-center justify-center">
          <Checkbox aria-label={selectLabel} checked={selected} onCheckedChange={toggleSelected} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DisplayEmail className="block font-medium" email={account.email} id={account.id} />
          {account.nickname ? (
            <span className="truncate text-muted-foreground text-xs">{account.nickname}</span>
          ) : null}
          <HealthBadges account={account} />
        </div>
        <EnabledSwitch account={account} />
        <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} variant="menu" />
      </div>
      <CreditMeters account={account} />
      <div className="flex flex-col gap-2">
        <AccountBadges account={account} />
        <dl className="grid grid-cols-4 gap-2 text-xs">
          <Stat label={t("columns.requests")} value={formatNumber(account.requestCount, lang)} />
          <Stat label={t("columns.tokens")} value={formatCompact(account.totalTokens)} />
          <Stat label={t("columns.credits")} value={Number(account.totalCredits).toFixed(1)} />
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

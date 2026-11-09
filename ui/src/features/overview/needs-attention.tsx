import {
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Flag02Icon,
  PanelRightOpenIcon,
  Refresh01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AuthIcon,
  hasAuthIcon,
  StatusPill,
  useAccountName,
} from "@/features/accounts/account-cells";
import { AccountDetailSheet } from "@/features/accounts/account-detail-sheet";
import { accountStatus, formatResetDate, statusGroup } from "@/features/accounts/account-model";
import { useRefreshAccount } from "@/features/accounts/use-account-actions";
import { accountsQuery } from "@/lib/api/accounts";
import type { Account } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ACCOUNT_STATUSES, type AccountStatus } from "@/routes/-search";

/** Rows the card lists; the header link opens the whole group on the Accounts page. */
const LIMIT = 5;

/** A dialog that can open again on the same account: each open is a new session. */
export interface DialogTarget {
  id: string;
  open: boolean;
  session: number;
}

/** One dialog's target and its open and close, as the Accounts page keeps them. */
export function useDialogTarget(): [DialogTarget | null, (id: string) => void, () => void] {
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

interface AttentionRow {
  account: Account;
  status: AccountStatus;
}

/**
 * The accounts that need a look (banned, suspended, no token, out of credits, token expired),
 * worst status first and, within one status, the most recently used first.
 */
export function attentionRows(accounts: readonly Account[], nowSec: number): AttentionRow[] {
  return accounts
    .map((account) => ({ account, status: accountStatus(account, nowSec) }))
    .filter((row) => statusGroup(row.status) === "attention")
    .sort(
      (a, b) =>
        ACCOUNT_STATUSES.indexOf(a.status) - ACCOUNT_STATUSES.indexOf(b.status) ||
        b.account.lastUsed - a.account.lastUsed,
    );
}

/** Why the account is in the list, in one muted line. */
function useReason(): (row: AttentionRow) => string | null {
  const { t, lang } = useT("overview");
  const { t: ta } = useT("accounts");
  return ({ account, status }) => {
    switch (status) {
      case "banned":
      case "suspended":
        return account.banReason || ta(`lockedSwitch.${status}`);
      case "noToken":
        return t("attention.reason.noToken");
      case "outOfCredits":
        return account.nextResetDate
          ? t("attention.reason.outOfCreditsReset", {
              date: formatResetDate(account.nextResetDate, lang),
            })
          : t("attention.reason.outOfCredits");
      case "expired":
        return t("attention.reason.expired", { time: formatDateTime(account.expiresAt, lang) });
      default:
        return null;
    }
  };
}

/** The sign-in mark in a round chip; a person for a method without a mark. */
function AuthChip({ account }: { account: Account }): JSX.Element {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border-subtle bg-surface-2 text-muted-foreground">
      {hasAuthIcon(account) ? (
        <AuthIcon account={account} />
      ) : (
        <HugeiconsIcon icon={UserIcon} aria-hidden="true" className="size-4" />
      )}
    </span>
  );
}

/**
 * The obvious fix: a new token for an expired, missing or suspended one (Kiro checks the account
 * again on refresh), otherwise the details, where the reason and the account's settings are.
 */
function FixAction({
  row,
  onDetails,
}: {
  row: AttentionRow;
  onDetails: (account: Account) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const refresh = useRefreshAccount(row.account.id);
  const refreshes =
    row.status === "expired" || row.status === "noToken" || row.status === "suspended";
  const label = refreshes ? t("actions.refreshToken") : t("actions.details");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            loading={refreshes && refresh.isPending}
            onClick={() => (refreshes ? refresh.mutate() : onDetails(row.account))}
            size="icon-sm"
            variant="outline"
          />
        }
      >
        <HugeiconsIcon icon={refreshes ? Refresh01Icon : PanelRightOpenIcon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function AttentionItem({
  row,
  reason,
  onDetails,
}: {
  row: AttentionRow;
  reason: string | null;
  onDetails: (account: Account) => void;
}): JSX.Element {
  const name = useAccountName()(row.account);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 sm:px-5" data-status={row.status}>
      <AuthChip account={row.account} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* One line: the name gives way (truncates) before the status pill would wrap. */}
        <div className="flex min-w-0 items-center gap-2">
          <TruncatedText className={cn("font-medium", name.mono && "font-mono text-meta")}>
            {name.text}
          </TruncatedText>
          <StatusPill account={row.account} plain size="sm" />
        </div>
        {reason ? (
          <TruncatedText className="text-meta text-muted-foreground">{reason}</TruncatedText>
        ) : null}
      </div>
      <FixAction onDetails={onDetails} row={row} />
    </li>
  );
}

function ViewAllLink(): JSX.Element {
  const { t } = useT("overview");
  const { t: tc } = useT();
  return (
    <Button
      aria-label={t("attention.viewAll")}
      render={<Link search={{ status: "attention" }} to="/accounts" />}
      size="sm"
      variant="ghost"
    >
      {tc("actions.viewAll")}
      <HugeiconsIcon icon={ArrowUpRight01Icon} aria-hidden="true" />
    </Button>
  );
}

/**
 * Needs attention: the accounts that are banned, suspended, without a token, out of credits or
 * on an expired token, worst first (at most five), each with its reason and one fix. The header
 * link opens the whole group on the Accounts page.
 */
export function NeedsAttention(): JSX.Element {
  const { t } = useT("overview");
  const query = useQuery(accountsQuery());
  const reasonOf = useReason();
  const [detail, openDetail, closeDetail] = useDialogTarget();
  // One clock per fetch, so a re-render does not move an account between statuses.
  const nowSec = Math.floor((query.dataUpdatedAt || Date.now()) / 1000);
  const rows = useMemo(
    () => (query.data ? attentionRows(query.data, nowSec) : []),
    [query.data, nowSec],
  );
  const onDetails = useCallback((account: Account) => openDetail(account.id), [openDetail]);

  let body: JSX.Element;
  if (query.isPending) {
    body = (
      <ul aria-hidden="true" className="flex flex-col">
        {[0, 1, 2].map((index) => (
          <li className="flex items-center gap-3 px-4 py-2.5 sm:px-5" key={index}>
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (query.isError && !query.data) {
    body = (
      <div className="px-4 py-4 sm:px-5">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("errors.accounts")}
        />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="px-4 py-6 sm:px-5">
        <EmptyState
          description={t("attention.emptyBody")}
          icon={CheckmarkCircle02Icon}
          title={t("attention.empty")}
          variant="compact"
        />
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-border-subtle">
        {rows.slice(0, LIMIT).map((row) => (
          <AttentionItem
            key={row.account.id}
            onDetails={onDetails}
            reason={reasonOf(row)}
            row={row}
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      <SectionCard
        actions={<ViewAllLink />}
        description={query.data ? t("attention.count", { count: rows.length }) : undefined}
        descriptionVariant="inline"
        icon={Flag02Icon}
        id="overview-attention"
        slim
        title={t("attention.title")}
      >
        {body}
      </SectionCard>
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
    </>
  );
}

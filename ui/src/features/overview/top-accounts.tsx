import { ArrowUpRight01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard, ListCardSkeleton } from "@/components/shared/list-card";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { LiveStatusPill } from "@/features/accounts/account-activity";
import {
  AccountIdentity,
  AuthIcon,
  UsageMeter,
  useAccountName,
} from "@/features/accounts/account-cells";
import { AccountDetailSheet } from "@/features/accounts/account-detail-sheet";
import {
  type AccountFailure,
  AccountFailureNotice,
  AccountFailureProvider,
} from "@/features/accounts/account-failure";
import { AccountRowActions } from "@/features/accounts/account-row-actions";
import { ReloginHost } from "@/features/accounts/relogin-host";
import { TestAccountDialog } from "@/features/accounts/test-account-dialog";
import { whenText } from "@/features/requests/request-cells";
import { accountsQuery } from "@/lib/api/accounts";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDialogTarget } from "./needs-attention";

/** Rows the card lists; the footer link opens every account, busiest first. */
const LIMIT = 5;

// Module-level, so the table's row props stay the same from one render to the next.
const topAccountId = (account: Account): string => account.id;
const renderTopAccountSkeleton = () => <ListCardSkeleton action leading meter variant="row" />;

/** The busiest accounts since the last statistics reset, most requests first. */
export function topAccounts(accounts: readonly Account[], limit = LIMIT): Account[] {
  return [...accounts]
    .sort((a, b) => b.requestCount - a.requestCount || b.lastUsed - a.lastUsed)
    .slice(0, limit);
}

/** Share of the account's requests that succeeded, or null before its first request. */
function successRate(account: Account): number | null {
  if (account.requestCount <= 0) return null;
  const failed = Math.min(account.errorCount, account.requestCount);
  return (account.requestCount - failed) / account.requestCount;
}

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The success rate as a ring: green from 95 %, orange from 85 %, red below, and an empty track
 * before the first request. The figure beside it carries the number, so the ring is decorative.
 */
function SuccessRing({ rate }: { rate: number | null }): JSX.Element {
  const tone =
    rate === null
      ? undefined
      : rate >= 0.95
        ? "stroke-success"
        : rate >= 0.85
          ? "stroke-warning"
          : "stroke-destructive";
  return (
    <span className="relative grid size-9 shrink-0 place-items-center">
      <svg aria-hidden="true" className="absolute inset-0 size-full -rotate-90" viewBox="0 0 36 36">
        <circle
          className="stroke-chart-scale-01"
          cx="18"
          cy="18"
          fill="none"
          r={RING_RADIUS}
          strokeWidth="3"
        />
        {rate === null ? null : (
          <circle
            className={tone}
            cx="18"
            cy="18"
            fill="none"
            r={RING_RADIUS}
            strokeDasharray={`${RING_LENGTH * rate} ${RING_LENGTH}`}
            strokeLinecap="round"
            strokeWidth="3"
          />
        )}
      </svg>
    </span>
  );
}

/** "97% success" over "62/64 requests"; "No requests yet" before the first one. */
function SuccessCell({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("overview");
  const rate = successRate(account);
  const failed = Math.min(account.errorCount, account.requestCount);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <SuccessRing rate={rate} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium tabular-nums">
          {rate === null
            ? t("topAccounts.noRequests")
            : t("topAccounts.success", { percent: Math.floor(rate * 100) })}
        </span>
        <span className="text-meta text-muted-foreground tabular-nums">
          {t("topAccounts.requests", {
            count: account.requestCount,
            succeeded: formatNumber(account.requestCount - failed, lang),
            total: formatNumber(account.requestCount, lang),
          })}
        </span>
      </div>
    </div>
  );
}

/**
 * The clock time of the last request (its date when not today) over how long ago it was; a dash
 * when never used.
 */
function LastUsedCell({ account }: { account: Account }): JSX.Element {
  const { lang } = useT();
  if (!account.lastUsed) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="tabular-nums">{whenText(account.lastUsed, lang)}</span>
      <RelativeTime className="text-meta text-muted-foreground" value={account.lastUsed} />
    </div>
  );
}

/** The phone row: ring, name with its sign-in mark, status, requests and the credits meter. */
function TopAccountCard({
  account,
  onTest,
  onDetails,
}: {
  account: Account;
  onTest: (account: Account) => void;
  onDetails: (account: Account) => void;
}): JSX.Element {
  const { t } = useT("overview");
  const { t: ta } = useT("accounts");
  const name = useAccountName()(account);
  const rate = successRate(account);
  return (
    <ListCard
      action={
        <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} variant="menu" />
      }
      leading={<SuccessRing rate={rate} />}
      meta={
        // The status leads the meta line, as on the Accounts page cards, so the title keeps its
        // one line and the pill never drops under it.
        <span className="flex min-w-0 items-center gap-1.5">
          <LiveStatusPill account={account} size="sm" />
          {/* The rate the ring draws; the request counts are in the table and the sheet. */}
          <span className="truncate tabular-nums">
            {rate === null
              ? t("topAccounts.noRequests")
              : t("topAccounts.success", { percent: Math.floor(rate * 100) })}
          </span>
          <span aria-hidden="true">·</span>
          <RelativeTime style="narrow" value={account.lastUsed} />
        </span>
      }
      onOpen={() => onDetails(account)}
      openLabel={ta("openDetails", { email: name.text })}
      title={
        // pe-0.5: the AWS mark draws 2 px past its box, which the title's truncation clipped.
        <span className="flex min-w-0 items-center gap-2 pe-0.5">
          <TruncatedText className={cn(name.mono && "font-mono text-meta")}>
            {name.text}
          </TruncatedText>
          <AuthIcon account={account} />
        </span>
      }
      variant="row"
    >
      {/* No dash row for an account without a plan (an API key): the card stays two lines. */}
      {account.usageLimit > 0 || account.trialUsageLimit > 0 ? (
        <UsageMeter account={account} />
      ) : null}
    </ListCard>
  );
}

function FooterLink({ focusRef }: { focusRef: RefObject<HTMLElement | null> }): JSX.Element {
  const { t } = useT("overview");
  return (
    <Button
      // The arrow, not the invisible box, lines up with the card's content edge (its 8 px inset).
      className="-me-2"
      ref={(element) => {
        focusRef.current = element;
      }}
      render={<Link search={{ sort: "requests", order: "desc" }} to="/accounts" />}
      size="sm"
      variant="ghost"
    >
      {t("topAccounts.viewAll")}
      <HugeiconsIcon icon={ArrowUpRight01Icon} aria-hidden="true" />
    </Button>
  );
}

/**
 * The most active accounts since the last statistics reset: their success rate as a ring, the
 * account, when it last served a request, its plan credits, status and the row actions of the
 * Accounts table (test, refresh token, more). Cards on narrow cards; the footer opens them all.
 * A row action's failure (Refresh token, Copy JSON, Delete) is one line above the rows.
 */
export function TopAccounts(): JSX.Element {
  const { t, lang } = useT("overview");
  const { t: ta } = useT("accounts");
  const { t: tc } = useT();
  const query = useQuery(accountsQuery());
  const accountName = useAccountName();
  const [detail, openDetail, closeDetail] = useDialogTarget();
  const [test, openTest, closeTest] = useDialogTarget();
  const onDetails = useCallback((account: Account) => openDetail(account.id), [openDetail]);
  const onTest = useCallback((account: Account) => openTest(account.id), [openTest]);

  const accounts = query.data;
  const rows = useMemo(() => (accounts ? topAccounts(accounts) : []), [accounts]);
  const testAccount = test ? accounts?.find((account) => account.id === test.id) : undefined;

  // The last failed row action, with Try again and close; the next action clears it.
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  // Focus for a notice whose own control is gone (a deleted row's menu).
  const footerLinkRef = useRef<HTMLElement>(null);
  const focusFooterLink = useCallback(() => footerLinkRef.current, []);
  // It goes with its account once that leaves the card (deleted, or no longer among the busiest).
  useEffect(() => {
    const id = failure?.accountId;
    if (id && accounts && !rows.some((account) => account.id === id)) setFailure(null);
  }, [failure, accounts, rows]);

  const columns = useMemo<DataTableColumn<Account>[]>(
    () => [
      {
        id: "success",
        header: t("topAccounts.successColumn"),
        className: "w-52",
        headerClassName: "w-52",
        cell: (account) => <SuccessCell account={account} />,
      },
      {
        id: "account",
        header: ta("columns.account"),
        cell: (account) => (
          <AccountIdentity account={account} className="w-full contain-inline-size" />
        ),
      },
      {
        id: "lastUsed",
        header: ta("columns.lastUsed"),
        className: "w-32",
        headerClassName: "w-32",
        cell: (account) => <LastUsedCell account={account} />,
      },
      {
        id: "usage",
        header: ta("columns.planCredits"),
        className: "w-44",
        headerClassName: "w-44",
        cell: (account) => <UsageMeter account={account} />,
      },
      {
        id: "status",
        header: ta("columns.status"),
        className: "w-36",
        headerClassName: "w-36",
        cell: (account) => <LiveStatusPill account={account} />,
      },
      {
        id: "actions",
        header: <span className="sr-only">{tc("table.actions")}</span>,
        align: "end",
        className: "w-32",
        headerClassName: "w-32",
        sticky: "end",
        cell: (account) => (
          <AccountRowActions account={account} onDetails={onDetails} onTest={onTest} />
        ),
      },
    ],
    [t, ta, tc, onDetails, onTest],
  );

  const renderCard = useCallback(
    (account: Account) => (
      <TopAccountCard account={account} onDetails={onDetails} onTest={onTest} />
    ),
    [onDetails, onTest],
  );
  const rowLabel = useCallback(
    (account: Account) => ta("openDetails", { email: accountName(account).text }),
    [ta, accountName],
  );
  const emptyState = useMemo(
    () => (
      <EmptyState
        description={t("topAccounts.emptyBody")}
        icon={UserGroupIcon}
        title={t("topAccounts.empty")}
        variant="compact"
      />
    ),
    [t],
  );

  const total = accounts?.length ?? 0;
  let body: JSX.Element;
  if (query.isError && !accounts) {
    body = (
      <div className="p-4">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("errors.accounts")}
        />
      </div>
    );
  } else {
    body = (
      <>
        {failure ? (
          <CardPanel>
            <AccountFailureNotice
              failure={failure}
              fallbackFocus={focusFooterLink}
              report={setFailure}
            />
          </CardPanel>
        ) : null}
        <DataTable
          caption={t("topAccounts.title")}
          cardLayout="divided"
          cardsBelow="3xl"
          columns={columns}
          data={rows}
          density="comfortable"
          emptyState={emptyState}
          getRowId={topAccountId}
          inset
          loading={query.isPending}
          onRowClick={onDetails}
          pageSize={LIMIT}
          // Each fetch renders the rows again, so their status reads the clock afresh.
          refreshKey={query.dataUpdatedAt}
          renderCard={renderCard}
          renderCardSkeleton={renderTopAccountSkeleton}
          rowLabel={rowLabel}
        />
      </>
    );
  }

  return (
    <ReloginHost>
      <AccountFailureProvider fallbackFocus={focusFooterLink} report={setFailure}>
        <SectionCard
          description={t("topAccounts.description")}
          descriptionVariant="inline"
          footer={
            total > 0 ? (
              <>
                <p>
                  {t("topAccounts.showing", {
                    count: total,
                    shown: formatNumber(rows.length, lang),
                    total: formatNumber(total, lang),
                  })}
                </p>
                <FooterLink focusRef={footerLinkRef} />
              </>
            ) : undefined
          }
          icon={UserGroupIcon}
          id="overview-top-accounts"
          slim
          title={t("topAccounts.title")}
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
      </AccountFailureProvider>
    </ReloginHost>
  );
}

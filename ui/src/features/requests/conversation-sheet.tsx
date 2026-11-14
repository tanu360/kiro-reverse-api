import { ArrowDataTransferHorizontalIcon, FilterHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { CreditAmount } from "@/components/shared/credit-amount";
import { DisplayEmail } from "@/components/shared/display-email";
import { ErrorState } from "@/components/shared/error-state";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
import { StatStrip, type StatStripItem } from "@/components/shared/stat-strip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationQuery } from "@/lib/api/requests";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs, formatNumber, formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { StatusBadge } from "./requests-columns";

/** The short form of a conversation id the pages show: its first eight characters. */
export function shortConversationId(id: string): string {
  return id.slice(0, 8);
}

/**
 * One conversation's turns in order, opened from a request's detail: the account each turn used,
 * its result and failovers, and the totals over all of them. "Show in the log" filters Requests
 * to this conversation.
 */
export function ConversationSheet({
  conversationId,
  currentId,
  open,
  onOpenChange,
  onShowInLog,
}: {
  conversationId: string;
  /** The request the sheet was opened from, marked in the list. */
  currentId?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowInLog?: (conversationId: string) => void;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const query = useQuery({ ...conversationQuery(conversationId), enabled: open });
  const data = query.data;

  let body: JSX.Element;
  if (query.isError) {
    body = (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        title={t("conversation.loadError")}
      />
    );
  } else if (!data) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else {
    const totals = data.totals;
    const stats: StatStripItem[] = [
      { label: t("conversation.turns"), value: formatNumber(totals.requests, lang) },
      {
        label: t("tokens"),
        value: formatNumber(totals.inTokens + totals.outTokens, lang),
      },
      { label: t("credits"), value: <CreditAmount digits={4} value={totals.credits} /> },
      { label: t("duration"), value: formatDurationMs(totals.durationMs, true, lang) },
    ];
    body = (
      <>
        <SectionCard slim title={t("conversation.summary")}>
          <StatStrip items={stats} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-muted-foreground text-xs sm:px-6">
            <span>
              {t("conversation.span", {
                first: formatDateTime(totals.firstTs, lang),
                last: formatTime(totals.lastTs, lang),
              })}
            </span>
            <span>
              {t("conversation.results", { ok: totals.successes, failed: totals.failures })}
            </span>
            <span>{t("conversation.failovers", { count: totals.failovers })}</span>
            <span>{t("conversation.accounts", { count: totals.accounts.length })}</span>
            {totals.accountMoves > 0 ? (
              <span>{t("conversation.moves", { count: totals.accountMoves })}</span>
            ) : null}
          </div>
        </SectionCard>
        {data.truncated ? (
          <Alert role="note" size="sm" variant="info">
            <AlertDescription>{t("conversation.truncated")}</AlertDescription>
          </Alert>
        ) : null}
        <SectionCard
          icon={ArrowDataTransferHorizontalIcon}
          slim
          title={t("conversation.turnsTitle")}
        >
          <ol className="divide-y divide-border-subtle">
            {data.turns.map((turn, index) => (
              <TurnRow
                current={turn.id === currentId}
                index={index + 1}
                key={turn.id ?? index}
                turn={turn}
              />
            ))}
          </ol>
        </SectionCard>
      </>
    );
  }

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader className="gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <ResponsiveSheetTitle>{t("conversation.title")}</ResponsiveSheetTitle>
          <ResponsiveSheetDescription className="truncate font-mono" translate="no">
            {conversationId}
          </ResponsiveSheetDescription>
        </div>
        {onShowInLog ? (
          <div className="flex flex-wrap items-center gap-2 sm:-me-8">
            <Button onClick={() => onShowInLog(conversationId)} size="sm" variant="secondary">
              <HugeiconsIcon aria-hidden="true" icon={FilterHorizontalIcon} />
              {t("conversation.showInLog")}
            </Button>
          </div>
        ) : null}
      </ResponsiveSheetHeader>
      <ResponsiveSheetPanel className="flex flex-col gap-4">{body}</ResponsiveSheetPanel>
    </ResponsiveSheet>
  );
}

/** One turn: its number and time, the result, the model and account, tokens and time taken. */
function TurnRow({
  turn,
  index,
  current,
}: {
  turn: RequestRecord;
  index: number;
  current: boolean;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const failovers = turn.attempts?.filter((attempt) => attempt.failover).length ?? 0;
  return (
    <li
      aria-current={current ? "true" : undefined}
      className="flex flex-col gap-1.5 px-4 py-3 aria-[current=true]:bg-accent sm:px-6"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-sm tabular-nums">
          {t("conversation.turn", { index })}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatTime(turn.ts, lang)}
        </span>
        <StatusBadge record={turn} size="sm" />
        {turn.replayOf ? (
          <Badge size="sm" tone="primary">
            {t("replay.badge", { id: turn.replayOf })}
          </Badge>
        ) : null}
        {current ? (
          <Badge size="sm" tone="neutral">
            {t("conversation.current")}
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span className="text-foreground">{turn.model || EMPTY}</span>
        {turn.email || turn.accountId ? (
          <span className="min-w-0 truncate">
            <DisplayEmail email={turn.email} id={turn.accountId} />
          </span>
        ) : null}
        <span className="tabular-nums">
          {t("card.tokens", { value: formatNumber(turn.inTokens + turn.outTokens, lang) })}
        </span>
        <span className="tabular-nums">{formatDurationMs(turn.durationMs, true, lang)}</span>
        {failovers > 0 ? (
          <span className="text-warning-foreground">
            {t("conversation.turnFailovers", { count: failovers })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

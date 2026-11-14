import {
  AlertCircleIcon,
  ArrowDataTransferHorizontalIcon,
  BubbleChatIcon,
  Message01Icon,
  PlayIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, Suspense, useId, useState } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { CreditAmount } from "@/components/shared/credit-amount";
import { PagerChevronButton } from "@/components/shared/data-table-pagination";
import { DisplayEmail } from "@/components/shared/display-email";
import { InfoHint } from "@/components/shared/info-hint";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import { ModelLogo } from "@/components/shared/model-logo";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
import { StatStrip, type StatStripItem } from "@/components/shared/stat-strip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accountsQuery } from "@/lib/api/accounts";
import type { RequestRecord } from "@/lib/api/types";
import {
  dateTimeFormat,
  EMPTY,
  formatDurationMs,
  formatNumber,
  formatPercent,
  unixToDate,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ConversationSheet } from "./conversation-sheet";
import { requestProxyText } from "./proxy-failure";
import { ReplayDialog } from "./replay-dialog";
import { AttemptsCard } from "./request-attempts";
import { isKnownErrorType, normalizeApiKeyMask, rowKey } from "./request-model";
import { endpointLabel, StatusBadge } from "./requests-columns";

// The account's own sheet opens over this one; its code stays out of the Requests chunk until then.
const AccountDetailSheet = lazy(() =>
  import("@/features/accounts/account-detail-sheet").then((module) => ({
    default: module.AccountDetailSheet,
  })),
);

interface RequestDetailSheetProps {
  record: RequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 1-based position of the record on the current page, or 0 when it left the page. */
  position: number;
  count: number;
  onPrevious?: () => void;
  onNext?: () => void;
  /** Filters the log to one conversation (from the conversation sheet). */
  onShowConversation?: (conversationId: string) => void;
}

/**
 * Row detail on the shared ResponsiveSheet (a right sheet from md up, a bottom sheet on phones),
 * laid out as the account sheet: the model's mark beside the model (the title) over the result
 * and the exact time, then the actions (open the account's sheet over this one, copy the row as
 * JSON). Then the numbers: duration, credits and tokens in one strip over the input and output
 * split with the cache counts; and one card with the request's facts and its IDs as label-over-
 * value grids, so no value sits a card's width away from its label. A failed request leads with
 * its error as a red notice (the sign-in form's soft tag); a message on a succeeded one comes
 * last, neutral.
 */
export function RequestDetailSheet({
  record,
  open,
  onOpenChange,
  position,
  count,
  onPrevious,
  onNext,
  onShowConversation,
}: RequestDetailSheetProps): JSX.Element {
  const { t, lang } = useT("requests");
  const maskText = useMaskText();
  // Each Open account mounts a fresh sheet (a new session key), kept mounted while it closes.
  const [accountSheet, setAccountSheet] = useState<{
    id: string;
    open: boolean;
    session: number;
  } | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const accountId = record?.accountId ?? "";
  // Only to hide Open account for an account that has since been removed; shared with Accounts.
  const accounts = useQuery({ ...accountsQuery(), enabled: open && accountId !== "" });
  const accountGone =
    accounts.data !== undefined && !accounts.data.some((account) => account.id === accountId);

  let body: JSX.Element | null = null;
  if (record) {
    const failed = !record.success;
    const apiKey = normalizeApiKeyMask(record.apiKeyMasked);
    const message =
      maskText(record.message) || (failed ? t("noErrorMessage") : t("detail.noMessage"));
    // A Proxy error reads as its Attempts word it; the client's own error stays behind Details,
    // as the proxy pool keeps the server's text behind its Last error.
    const proxyText = requestProxyText(record, t);
    // A failure that used no tokens has nothing to break down: the table shows a dash there too.
    const noUsage =
      failed &&
      record.inTokens + record.outTokens === 0 &&
      !record.cacheReadTokens &&
      !record.cacheWriteTokens;

    const stats: StatStripItem[] = [
      {
        label: t("duration"),
        value: formatDurationMs(record.durationMs, Boolean(record.endpoint), lang),
      },
      {
        label: t("credits"),
        // Nothing was billed for a failure that used no credits: a dash, as in the table.
        value:
          failed && record.credits === 0 ? (
            <span className="font-normal text-muted-foreground">{EMPTY}</span>
          ) : (
            <CreditAmount digits={4} value={record.credits} />
          ),
      },
    ];
    if (!noUsage) {
      stats.push({
        label: t("tokens"),
        value: formatNumber(record.inTokens + record.outTokens, lang),
      });
    }

    // The message as a notice in the sign-in form's soft tag: red with the error's category as
    // its title for a failure, neutral for a message on a request that succeeded.
    const type = record.errorType;
    const notice =
      failed || record.message ? (
        <Alert role="none" variant={failed ? "error" : "default"}>
          <HugeiconsIcon aria-hidden="true" icon={failed ? AlertCircleIcon : Message01Icon} />
          {/* The copy button on the title's line at every width, so a phone keeps it at the top. */}
          <AlertTitle className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              {failed
                ? type
                  ? isKnownErrorType(type)
                    ? t(`errorType.${type}`)
                    : type
                  : t("error")
                : t("detail.message")}
            </span>
            <CopyButton
              className="-my-0.5 -me-1.5 shrink-0"
              label={t("detail.copyMessage")}
              size="icon-xs"
              value={message}
            />
          </AlertTitle>
          <AlertDescription>
            {proxyText ? (
              <p className="wrap-anywhere" data-testid="request-message">
                {proxyText}{" "}
                <InfoHint
                  hint={<span className="whitespace-pre-wrap wrap-anywhere">{message}</span>}
                  side="bottom"
                >
                  {t("detail.errorDetails")}
                </InfoHint>
              </p>
            ) : (
              <p className="whitespace-pre-wrap wrap-anywhere" data-testid="request-message">
                {message}
              </p>
            )}
          </AlertDescription>
        </Alert>
      ) : null;

    // Two across: a succeeded request pairs the endpoint with its status code (a failure's badge
    // in the header already carries the code, so its account takes the full row instead).
    const showStatus = !failed && Boolean(record.status);
    const account: KeyValueItem = {
      label: t("account"),
      value:
        record.email || record.accountId ? (
          <DisplayEmail email={record.email} id={record.accountId} />
        ) : (
          <span className="text-muted-foreground">{EMPTY}</span>
        ),
      span: showStatus ? 1 : 2,
    };
    const apiKeyItem: KeyValueItem = apiKey
      ? { label: t("apiKey"), value: apiKey, mono: true }
      : { label: t("apiKey"), value: <span className="text-muted-foreground">{EMPTY}</span> };
    const facts: KeyValueItem[] = showStatus
      ? [
          { label: t("endpoint"), value: endpointLabel(record.endpoint, t) },
          { label: t("detail.statusCode"), value: String(record.status) },
          account,
          apiKeyItem,
        ]
      : [{ label: t("endpoint"), value: endpointLabel(record.endpoint, t) }, apiKeyItem, account];

    // IDs run the card's full width: UUIDs in mono fit there and not in half of it. The request's
    // own ID is a short number, so it sits in the card's header instead.
    const ids: KeyValueItem[] = [
      idItem(t("detail.accountId"), record.accountId),
      idItem(t("detail.apiKeyId"), record.apiKeyId),
      idItem(t("detail.traceId"), record.requestId),
      idItem(t("detail.conversationId"), record.conversationId),
    ];

    body = (
      // Keyed on the record so Previous and Next open each one scrolled to the top.
      <ResponsiveSheetPanel className="flex flex-col gap-4" key={rowKey(record, position)}>
        {/* A failure leads with its error, above the numbers. */}
        {failed ? notice : null}

        <NumbersCard record={record} stats={stats} usage={!noUsage} />

        <SectionCard
          actions={
            record.id === undefined ? undefined : (
              // Plain text, no copy button: a short number reads and types as it is, and Copy as
              // JSON carries it too. Screen readers hear "Request ID 12140".
              <span className="font-mono text-muted-foreground tabular-nums">
                <span className="sr-only">{t("detail.requestId")} </span>
                <span aria-hidden="true">#</span>
                {record.id}
              </span>
            )
          }
          icon={ArrowDataTransferHorizontalIcon}
          slim
          title={t("detail.request")}
        >
          {record.replayOf ? (
            <div className="px-4 pt-4 sm:px-6">
              <Badge size="sm" tone="primary">
                {t("replay.badge", { id: record.replayOf })}
              </Badge>
            </div>
          ) : null}
          <div className="px-4 py-4 sm:px-6">
            <KeyValueGrid items={facts} />
          </div>
          <div className="px-4 py-4 sm:px-6">
            <KeyValueGrid columns={1} items={ids} />
          </div>
        </SectionCard>

        <AttemptsCard attempts={record.attempts} />

        {failed ? null : notice}
      </ResponsiveSheetPanel>
    );
  }

  const canOpenAccount = accountId !== "" && !accountGone;

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader className={record ? "gap-4" : undefined}>
        <div className="flex items-start gap-3">
          {/* The model maker's mark on the account sheet's avatar tile. Decorative. */}
          <span
            aria-hidden="true"
            className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-2"
          >
            <ModelLogo className="size-5" model={record?.model ?? ""} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* The model names the request, as a log line's path does; an auth failure has none. */}
            <ResponsiveSheetTitle className="truncate">
              {record?.model || t("detail.title")}
            </ResponsiveSheetTitle>
            {/* The result leads the time, as the status pill leads the account sheet's meta line. */}
            <div className="flex min-w-0 items-center gap-2">
              {record ? <StatusBadge record={record} size="sm" /> : null}
              <ResponsiveSheetDescription className="min-w-0 truncate">
                {record ? exactTime(record.ts, lang) : EMPTY}
              </ResponsiveSheetDescription>
            </div>
          </div>
        </div>
        {record ? (
          /*
            From sm up the header keeps 56 px at its end for the close button; the actions sit
            under it, so they run out to the cards' 24 px edge instead (as on the account sheet).
          */
          <div className="flex flex-wrap items-center gap-2 sm:-me-8">
            {canOpenAccount ? (
              <Button
                onClick={() =>
                  setAccountSheet((current) => ({
                    id: accountId,
                    open: true,
                    session: (current?.session ?? 0) + 1,
                  }))
                }
                size="sm"
                variant="secondary"
              >
                <HugeiconsIcon aria-hidden="true" icon={UserCircleIcon} />
                {t("detail.openAccount")}
              </Button>
            ) : null}
            {record.conversationId ? (
              <Button onClick={() => setConversationOpen(true)} size="sm" variant="secondary">
                <HugeiconsIcon aria-hidden="true" icon={BubbleChatIcon} />
                {t("detail.openConversation")}
              </Button>
            ) : null}
            {record.hasBody && record.id !== undefined ? (
              <Button onClick={() => setReplayOpen(true)} size="sm" variant="secondary">
                <HugeiconsIcon aria-hidden="true" icon={PlayIcon} />
                {t("detail.replay")}
              </Button>
            ) : null}
            <CopyButton
              className="ms-auto"
              label={t("detail.copyJson")}
              showLabel
              value={() => Promise.resolve(recordJson(record, maskText))}
            />
          </div>
        ) : null}
      </ResponsiveSheetHeader>
      {body}
      <ResponsiveSheetFooter>
        <span className="text-meta text-muted-foreground tabular-nums">
          {position > 0 ? t("detail.position", { index: position, count }) : null}
        </span>
        <div className="flex items-center gap-2">
          {/* The table pager's chevrons, so both pairs on the page look and dim alike. */}
          <PagerChevronButton
            direction="previous"
            disabled={!onPrevious}
            label={t("detail.previous")}
            onClick={() => onPrevious?.()}
          />
          <PagerChevronButton
            direction="next"
            disabled={!onNext}
            label={t("detail.next")}
            onClick={() => onNext?.()}
          />
        </div>
      </ResponsiveSheetFooter>
      {record?.conversationId ? (
        <ConversationSheet
          conversationId={record.conversationId}
          currentId={record.id}
          key={record.conversationId}
          onOpenChange={setConversationOpen}
          onShowInLog={
            onShowConversation
              ? (id) => {
                  setConversationOpen(false);
                  onShowConversation(id);
                }
              : undefined
          }
          open={conversationOpen && open}
        />
      ) : null}
      {record?.hasBody ? (
        <ReplayDialog
          key={`replay-${record.id}`}
          onOpenChange={setReplayOpen}
          open={replayOpen && open}
          record={record}
        />
      ) : null}
      {/* Rendered inside this sheet, so it opens as a nested sheet and Escape closes it first. */}
      {accountSheet ? (
        <Suspense fallback={null}>
          <AccountDetailSheet
            accountId={accountSheet.id}
            key={`account-${accountSheet.session}`}
            onOpenChange={(next) =>
              setAccountSheet((current) => (current ? { ...current, open: next } : null))
            }
            open={accountSheet.open && open}
          />
        </Suspense>
      ) : null}
    </ResponsiveSheet>
  );
}

/** An ID in mono with a copy button, or a muted dash when the row has none. */
function idItem(label: string, value: string | undefined): KeyValueItem {
  return value
    ? { label, value, span: 2, mono: true, copy: true }
    : { label, value: <span className="text-muted-foreground">{EMPTY}</span>, span: 2 };
}

/** "Nov 11, 2026, 5:46:12 PM": a log line's time, to the second. */
function exactTime(unixSec: number, lang: Lang): string {
  return dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "medium" }).format(
    unixToDate(unixSec),
  );
}

/**
 * The row as the API sent it, for a bug report or a support ticket: the email and message pass
 * through privacy masking, as on screen, and the API key keeps its mask.
 */
function recordJson(record: RequestRecord, maskText: (text?: string) => string): string {
  return JSON.stringify(
    {
      ...record,
      email: record.email ? maskText(record.email) : record.email,
      apiKeyMasked: normalizeApiKeyMask(record.apiKeyMasked) || record.apiKeyMasked,
      message: record.message ? maskText(record.message) : record.message,
      attempts: record.attempts?.map((attempt) => ({
        ...attempt,
        email: attempt.email ? maskText(attempt.email) : attempt.email,
        message: attempt.message ? maskText(attempt.message) : attempt.message,
      })),
    },
    null,
    2,
  );
}

/**
 * The sheet's opening card, as the account sheet's: duration, credits and tokens in one strip,
 * then the tokens split into input and output on one bar (input purple, output pink, the chart
 * palette's first two) over the four counts. Cache reads and writes are parts of the input, so
 * they have no colour of their own; a cache read also says what share of the input it was. The
 * section keeps a "Summary" name for screen readers; the numbers carry their own labels.
 */
function NumbersCard({
  record,
  stats,
  usage,
}: {
  record: RequestRecord;
  stats: StatStripItem[];
  /** False for a failure that used no tokens: the strip alone, with no breakdown. */
  usage: boolean;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const headingId = useId();
  const series = [
    { label: t("tokens.input"), value: record.inTokens, color: "var(--chart-1)" },
    { label: t("tokens.output"), value: record.outTokens, color: "var(--chart-2)" },
  ];
  const cacheRead = record.cacheReadTokens ?? 0;
  const cacheWrite = record.cacheWriteTokens ?? 0;

  return (
    <Card
      aria-labelledby={headingId}
      className="@container min-w-0"
      data-slot="section-card"
      render={<section />}
    >
      <h2 className="sr-only" id={headingId}>
        {t("detail.summary")}
      </h2>
      <StatStrip items={stats} />
      {usage ? (
        <div className="border-border-subtle border-t px-4 py-4 sm:px-6">
          {/* Each part grows by its count; a 4 px floor keeps a small output visible. */}
          <div
            aria-hidden="true"
            className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-chart-grid"
          >
            {series.map((item) =>
              item.value > 0 ? (
                <span
                  className="h-full min-w-1 basis-0 rounded-full"
                  key={item.label}
                  // The colour is series data, so it stays an inline style (as the chart legend).
                  style={{ flexGrow: item.value, backgroundColor: item.color }}
                />
              ) : null,
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm @md:grid-cols-4">
            {series.map((item) => (
              <div className="flex min-w-0 flex-col gap-1" key={item.label}>
                <dt className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate">{item.label}</span>
                </dt>
                <dd className="tabular-nums">{formatNumber(item.value, lang)}</dd>
              </div>
            ))}
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="truncate text-meta text-muted-foreground">{t("tokens.cacheRead")}</dt>
              <dd className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
                {formatNumber(cacheRead, lang)}
                {cacheRead > 0 && record.inTokens > 0 ? (
                  <span className="text-meta text-muted-foreground">
                    {t("detail.ofInput", {
                      percent: formatPercent(cacheRead, record.inTokens, lang),
                    })}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="truncate text-meta text-muted-foreground">{t("tokens.cacheWrite")}</dt>
              <dd className="tabular-nums">{formatNumber(cacheWrite, lang)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </Card>
  );
}

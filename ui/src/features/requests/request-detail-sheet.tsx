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
import {
  type JSX,
  lazy,
  memo,
  type Ref,
  Suspense,
  useCallback,
  useDeferredValue,
  useId,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
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
import { scopedShortcuts } from "@/hooks/use-key-shortcut";
import { accountsQuery } from "@/lib/api/accounts";
import type { RequestRecord } from "@/lib/api/types";
import {
  dateTimeFormat,
  EMPTY,
  formatCreditsExact,
  formatDurationMs,
  formatNumber,
  formatPercent,
  unixToDate,
} from "@/lib/format";
import { fillNodes, type Lang, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ConversationSheet } from "./conversation-sheet";
import { requestProxyText } from "./proxy-failure";
import { ReplayDialog } from "./replay-dialog";
import { AttemptsCard } from "./request-attempts";
import { ErrorPill, outputSpeed, SpeedChip } from "./request-cells";
import { CallerLabel, requestCaller } from "./request-client";
import {
  endpointPath,
  isKnownErrorType,
  normalizeApiKeyMask,
  requestTries,
  rowKey,
} from "./request-model";
import { type RequestViewOptions, StatusBadge } from "./requests-columns";

/** The footer's previous and next record keys (KeyboardEvent.key, letters lower case). */
const PREVIOUS_KEYS = ["ArrowLeft", "k"] as const;
const NEXT_KEYS = ["ArrowRight", "j"] as const;

// The account's own sheet opens over this one; its code stays out of the Requests chunk until then.
const AccountDetailSheet = lazy(() =>
  import("@/features/accounts/account-detail-sheet").then((module) => ({
    default: module.AccountDetailSheet,
  })),
);

/**
 * The table's view options, read by the sheet as: `accounts` (default true) the account, API key
 * and conversation the request was routed with, and the Attempts card that names each attempt's
 * account (without it, only how many tries the request took); `messages` (default true) the
 * message notice (without it, a failure's category is a pill among the facts); `details`
 * (default false) what the table's detail columns show: the caller, the output speed, the exact
 * credits and milliseconds, and the request ID by the column's name. The user panel turns all
 * three the table's way, and `actions` off.
 */
interface RequestDetailSheetProps extends RequestViewOptions {
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
  /**
   * The header's actions (Open account, Conversation, Replay, Copy as JSON) and the sheets they
   * open, each of which reads the admin API or the admin's whole row. Default true; off for a
   * key holder, whose page makes no admin call.
   */
  actions?: boolean;
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
  accounts = true,
  messages = true,
  details = false,
  actions = true,
}: RequestDetailSheetProps): JSX.Element {
  const { t } = useT("requests");
  // Stepping through an open sheet moves the footer's position at once and shows the record as
  // soon as the main thread is free: a held arrow key then never queues up one full render per
  // key repeat. A sheet that opens shows its record at once.
  const deferredOpen = useDeferredValue(open);
  const deferredRecord = useDeferredValue(record);
  const deferredPosition = useDeferredValue(position);
  const stepping = open && deferredOpen;
  const shown = stepping ? deferredRecord : record;
  const shownPosition = stepping ? deferredPosition : position;
  // Each Open account mounts a fresh sheet (a new session key), kept mounted while it closes.
  const [accountSheet, setAccountSheet] = useState<{
    id: string;
    open: boolean;
    session: number;
  } | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  // Open account needs the account and the admin's actions; a key holder's sheet has neither.
  const accountId = accounts && actions ? (shown?.accountId ?? "") : "";
  // Only to hide Open account for an account that has since been removed; shared with Accounts.
  const accountList = useQuery({ ...accountsQuery(), enabled: open && accountId !== "" });
  const accountGone =
    accountList.data !== undefined && !accountList.data.some((account) => account.id === accountId);
  const canOpenAccount = accountId !== "" && !accountGone;
  const openAccount = useCallback(
    () =>
      setAccountSheet((current) => ({
        id: accountId,
        open: true,
        session: (current?.session ?? 0) + 1,
      })),
    [accountId],
  );
  const openConversation = useCallback(() => setConversationOpen(true), []);
  const openReplay = useCallback(() => setReplayOpen(true), []);

  return (
    <ResponsiveSheet
      onOpenChange={onOpenChange}
      // The footer's chevrons from the keyboard: Left or K for the previous record, Right or J
      // for the next, as their arrows point. Up and Down keep scrolling the sheet.
      onKeyDown={scopedShortcuts([
        { keys: PREVIOUS_KEYS, run: onPrevious },
        { keys: NEXT_KEYS, run: onNext },
      ])}
      open={open}
    >
      <RequestDetailHeader
        actions={actions}
        canOpenAccount={canOpenAccount}
        onOpenAccount={openAccount}
        onOpenConversation={openConversation}
        onOpenReplay={openReplay}
        record={shown}
      />
      {shown ? (
        <RequestDetailBody
          accounts={accounts}
          details={details}
          // Keyed on the record so Previous and Next open each one scrolled to the top.
          key={rowKey(shown, shownPosition)}
          messages={messages}
          record={shown}
        />
      ) : null}
      <ResponsiveSheetFooter>
        <span className="text-meta text-muted-foreground tabular-nums">
          {position > 0 ? t("detail.position", { index: position, count }) : null}
        </span>
        <div className="flex items-center gap-2">
          {/* The table pager's chevrons, so both pairs on the page look and dim alike. */}
          <PagerChevronButton
            direction="previous"
            disabled={!onPrevious}
            keyShortcuts="ArrowLeft K"
            label={t("detail.previous")}
            onClick={() => onPrevious?.()}
          />
          <PagerChevronButton
            direction="next"
            disabled={!onNext}
            keyShortcuts="ArrowRight J"
            label={t("detail.next")}
            onClick={() => onNext?.()}
          />
        </div>
      </ResponsiveSheetFooter>
      {actions && shown?.conversationId ? (
        <ConversationSheet
          conversationId={shown.conversationId}
          currentId={shown.id}
          key={shown.conversationId}
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
      {actions && shown?.hasBody ? (
        <ReplayDialog
          key={`replay-${shown.id}`}
          onOpenChange={setReplayOpen}
          open={replayOpen && open}
          record={shown}
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

/** Opens a row of the page in a SteppedRequestSheet; the page's rows call it. */
export interface RequestSheetHandle {
  open: (record: RequestRecord) => void;
}

interface Selection {
  key: string;
  record: RequestRecord;
}

/**
 * The detail sheet over a page of rows, stepping through them. The open row and the sheet's
 * state live here, not in the page, so a step renders the sheet and never the table; the page
 * opens a row through `ref`. A refetch keeps the open request by its key; one that left the page
 * stays open, unstepped.
 */
export function SteppedRequestSheet({
  ref,
  rows,
  getKey,
  onShowConversation,
  ...options
}: RequestViewOptions & {
  ref: Ref<RequestSheetHandle>;
  /** The page's rows, in the table's order. */
  rows: RequestRecord[];
  /** The table's row ID. */
  getKey: (record: RequestRecord, index: number) => string;
  /** Closes the sheet and filters the log to one conversation (from the conversation sheet). */
  onShowConversation?: (conversationId: string) => void;
  actions?: boolean;
}): JSX.Element {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [open, setOpen] = useState(false);
  const keys = useMemo(() => rows.map((row, index) => getKey(row, index)), [rows, getKey]);
  // Each key's first position, as indexOf finds it, so a step is a lookup and not a scan.
  const positions = useMemo(() => {
    const map = new Map<string, number>();
    keys.forEach((key, index) => {
      if (!map.has(key)) map.set(key, index);
    });
    return map;
  }, [keys]);
  const selectedIndex = selection ? (positions.get(selection.key) ?? -1) : -1;
  const selectedRecord = selectedIndex >= 0 ? rows[selectedIndex] : (selection?.record ?? null);

  useImperativeHandle(
    ref,
    () => ({
      open: (row) => {
        const index = rows.indexOf(row);
        if (index < 0) return;
        setSelection({ key: keys[index], record: row });
        setOpen(true);
      },
    }),
    [rows, keys],
  );

  const stepTo = (index: number) => {
    const row = rows[index];
    if (row) setSelection({ key: keys[index], record: row });
  };

  return (
    <RequestDetailSheet
      {...options}
      count={rows.length}
      onNext={
        selectedIndex >= 0 && selectedIndex < rows.length - 1
          ? () => stepTo(selectedIndex + 1)
          : undefined
      }
      onOpenChange={setOpen}
      onPrevious={selectedIndex > 0 ? () => stepTo(selectedIndex - 1) : undefined}
      onShowConversation={
        onShowConversation
          ? (conversation) => {
              setOpen(false);
              onShowConversation(conversation);
            }
          : undefined
      }
      open={open}
      position={selectedIndex + 1}
      record={selectedRecord}
    />
  );
}

/**
 * The sheet's header: the model's mark, the model, the result and the exact time, and the
 * actions. Memoized with the body, so a step that only moves the footer's position (the record
 * follows a moment later) does not render either again.
 */
const RequestDetailHeader = memo(function RequestDetailHeader({
  record,
  actions,
  canOpenAccount,
  onOpenAccount,
  onOpenConversation,
  onOpenReplay,
}: {
  record: RequestRecord | null;
  actions: boolean;
  canOpenAccount: boolean;
  onOpenAccount: () => void;
  onOpenConversation: () => void;
  onOpenReplay: () => void;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const maskText = useMaskText();
  return (
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
          {/* On a phone the time moves under the badge when both do not fit, never split. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {record ? <StatusBadge record={record} size="sm" /> : null}
            <ResponsiveSheetDescription className="min-w-0 truncate text-nowrap">
              {record ? exactTime(record.ts, lang) : EMPTY}
            </ResponsiveSheetDescription>
          </div>
        </div>
      </div>
      {record && actions ? (
        /*
          The header keeps 48 px at its end for the close button; the actions sit under it, so
          they run out to the cards' 16 px edge instead (as on the account sheet). A phone's
          header keeps no room; there the buttons keep their own widths and each line of them
          is centred.
        */
        <div className="flex flex-wrap items-center gap-2 -me-8 max-sm:me-0 max-sm:justify-center">
          {canOpenAccount ? (
            <Button onClick={onOpenAccount} size="sm" variant="secondary">
              <HugeiconsIcon aria-hidden="true" icon={UserCircleIcon} />
              {t("detail.openAccount")}
            </Button>
          ) : null}
          {record.conversationId ? (
            <Button onClick={onOpenConversation} size="sm" variant="secondary">
              <HugeiconsIcon aria-hidden="true" icon={BubbleChatIcon} />
              {t("detail.openConversation")}
            </Button>
          ) : null}
          {record.hasBody && record.id !== undefined ? (
            <Button onClick={onOpenReplay} size="sm" variant="secondary">
              <HugeiconsIcon aria-hidden="true" icon={PlayIcon} />
              {t("detail.replay")}
            </Button>
          ) : null}
          <CopyButton
            className="ms-auto max-sm:ms-0"
            label={t("detail.copyJson")}
            showLabel
            value={() => Promise.resolve(recordJson(record, maskText))}
          />
        </div>
      ) : null}
    </ResponsiveSheetHeader>
  );
});

/** The sheet's panel: the numbers, the request's facts and IDs, the attempts and the message. */
const RequestDetailBody = memo(function RequestDetailBody({
  record,
  accounts,
  messages,
  details,
}: {
  record: RequestRecord;
  accounts: boolean;
  messages: boolean;
  details: boolean;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const maskText = useMaskText();
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

  let credits: JSX.Element | string;
  if (failed && record.credits === 0) {
    // Nothing was billed for a failure that used no credits: a dash, as in the table.
    credits = <span className="font-normal text-muted-foreground">{EMPTY}</span>;
  } else if (details) {
    // The amount the table shows on hover, in full.
    credits = formatCreditsExact(record.credits, lang);
  } else {
    credits = <CreditAmount digits={4} value={record.credits} />;
  }
  const stats: StatStripItem[] = [
    {
      label: t("duration"),
      value: details ? (
        <ExactDuration record={record} />
      ) : (
        formatDurationMs(record.durationMs, Boolean(record.endpoint), lang)
      ),
    },
    { label: t("credits"), value: credits },
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
              {fillNodes(t("common:text.joinSentences"), {
                first: proxyText,
                second: (
                  <InfoHint
                    hint={<span className="whitespace-pre-wrap wrap-anywhere">{message}</span>}
                    side="bottom"
                  >
                    {t("detail.errorDetails")}
                  </InfoHint>
                ),
              })}
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
  // Without the message notice a failure keeps the code: its category leads the facts on a row
  // of its own (the pill does not fit half a phone's card), and the pairs stay a success's.
  const showStatus = (!failed || !messages) && Boolean(record.status);
  const statusItem: KeyValueItem = {
    label: t("detail.statusCode"),
    value: String(record.status),
  };
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
  const facts: KeyValueItem[] = [];
  // Without the message notice, a failure's category is the table's pill, without the code:
  // the status code is a fact of its own here.
  if (failed && !messages) {
    facts.push({
      label: t("error"),
      value: <ErrorPill record={record} status={false} />,
      span: 2,
    });
  }
  // The path, not the API's name: the Client fact names the API when no known tool called.
  const path = endpointPath(record.endpoint);
  facts.push(
    path === EMPTY
      ? { label: t("endpoint"), value: <span className="text-muted-foreground">{EMPTY}</span> }
      : { label: t("endpoint"), value: path, mono: true },
  );
  if (showStatus) facts.push(statusItem);
  if (details) {
    facts.push({
      label: t("detail.client"),
      value: requestCaller(record) ? (
        <CallerLabel record={record} />
      ) : (
        <span className="text-muted-foreground">{EMPTY}</span>
      ),
    });
  }
  if (accounts) {
    facts.push(...(showStatus ? [account, apiKeyItem] : [apiKeyItem, account]));
  } else {
    // The Attempts card names accounts, so only its count: none for a request refused first.
    const tries = requestTries(record);
    facts.push({
      label: t("attempts.title"),
      value:
        tries > 0 ? (
          formatNumber(tries, lang)
        ) : (
          <span className="text-muted-foreground">{EMPTY}</span>
        ),
    });
  }

  // IDs run the card's full width: UUIDs in mono fit there and not in half of it. The request's
  // own ID is a short number, so it sits in the card's header instead. The client's request ID
  // is the trace ID; the table's detail column calls it the request ID.
  const requestIdItem = idItem(details ? t("requestId") : t("detail.traceId"), record.requestId);
  const ids: KeyValueItem[] = accounts
    ? [
        idItem(t("detail.accountId"), record.accountId),
        idItem(t("detail.apiKeyId"), record.apiKeyId),
        requestIdItem,
        idItem(t("detail.conversationId"), record.conversationId),
      ]
    : [requestIdItem];

  return (
    <ResponsiveSheetPanel className="flex flex-col gap-4">
      {/* A failure leads with its error, above the numbers. */}
      {failed && messages ? notice : null}

      <NumbersCard record={record} speed={details} stats={stats} usage={!noUsage} />

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
        // A replay names its original beside the title, centred on the title's line.
        meta={
          record.replayOf ? (
            <Badge size="sm" tone="primary">
              {t("replay.badge", { id: record.replayOf })}
            </Badge>
          ) : undefined
        }
        slim
        title={t("detail.request")}
      >
        <div className="p-4">
          <KeyValueGrid items={facts} />
        </div>
        <div className="p-4">
          <KeyValueGrid columns={1} items={ids} />
        </div>
      </SectionCard>

      {accounts ? <AttemptsCard attempts={record.attempts} /> : null}

      {failed || !messages ? null : notice}
    </ResponsiveSheetPanel>
  );
});

/** An ID in mono with a copy button, or a muted dash when the row has none. */
function idItem(label: string, value: string | undefined): KeyValueItem {
  return value
    ? { label, value, span: 2, mono: true, copy: true }
    : { label, value: <span className="text-muted-foreground">{EMPTY}</span>, span: 2 };
}

/**
 * The duration as the strip reads it, over the exact milliseconds the table shows on hover (left
 * out under a second, where the two are the same).
 */
function ExactDuration({ record }: { record: RequestRecord }): JSX.Element {
  const { t, lang } = useT("requests");
  const text = formatDurationMs(record.durationMs, Boolean(record.endpoint), lang);
  const ms = Math.round(record.durationMs ?? 0);
  if (text === EMPTY || ms < 1000) return <>{text}</>;
  return (
    <>
      <span className="block truncate">{text}</span>
      <span className="block truncate font-normal text-meta text-muted-foreground">
        {t("durationExact", { n: formatNumber(ms, lang) })}
      </span>
    </>
  );
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
 * they have no colour of their own; a cache read also says what share of the input it was, and
 * with `speed` the output how fast it came. The section keeps a "Summary" name for screen
 * readers; the numbers carry their own labels.
 */
function NumbersCard({
  record,
  stats,
  usage,
  speed = false,
}: {
  record: RequestRecord;
  stats: StatStripItem[];
  /** False for a failure that used no tokens: the strip alone, with no breakdown. */
  usage: boolean;
  /**
   * The Speed column's figure beside the output, in its colour (the strip is too narrow for a
   * fourth number in words); none for a failure or a reply with no output.
   */
  speed?: boolean;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const headingId = useId();
  const series = [
    { label: t("tokens.input"), value: record.inTokens, color: "var(--chart-1)", note: null },
    {
      label: t("tokens.output"),
      value: record.outTokens,
      color: "var(--chart-2)",
      note: speed && outputSpeed(record) !== undefined ? <SpeedChip record={record} /> : null,
    },
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
        <div className="border-border-subtle border-t p-4">
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
                {item.note ? (
                  <dd className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
                    {formatNumber(item.value, lang)}
                    <span className="text-meta">{item.note}</span>
                  </dd>
                ) : (
                  <dd className="tabular-nums">{formatNumber(item.value, lang)}</dd>
                )}
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

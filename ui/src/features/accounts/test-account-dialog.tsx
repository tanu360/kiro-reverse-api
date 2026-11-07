import {
  AlertCircleIcon,
  ArrowDataTransferVerticalIcon,
  CircleCheckIcon,
  CircleXIcon,
  Coins01Icon,
  FlaskConicalIcon,
  InformationCircleIcon,
  PlayIcon,
  Timer01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type KeyboardEvent, memo, useEffect, useId, useRef, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { EMPTY_SIZING } from "@/components/shared/empty-state";
import { IconChip } from "@/components/shared/icon-chip";
import { ModelLogo } from "@/components/shared/model-logo";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { TruncatedText } from "@/components/shared/truncated-text";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardHeader,
  CardHeading,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { getAccountModelsCached, testAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, TestAccountResponse } from "@/lib/api/types";
import { formatClockTime, formatCreditsExact, formatDecimal, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail, useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { StatusPill } from "./account-cells";
import { authLabel, planLabel } from "./account-model";

/** The old UI's fallback when nothing is cached (the server's own default differs). */
const DEFAULT_TEST_MODEL = "claude-sonnet-4.6";
export const MAX_LOG_LINES = 100;

type LogType = "info" | "ok" | "warn" | "err";
interface LogLine {
  id: number;
  time: string;
  type: LogType;
  text: string;
  /** A model id inside `text` that must not wrap at its hyphens ("claude-" / "sonnet-4.6"). */
  keep?: string;
}

/** The latest finished run, for the result card; the step list keeps every run. */
type Outcome =
  | { kind: "ok"; seconds: string; result: TestAccountResponse }
  | { kind: "err"; seconds: string; reason: string };

/** The line text with its `keep` part (first match) on one line; the rest wraps as usual. */
function LogText({ text, keep }: { text: string; keep?: string }): JSX.Element {
  const at = keep ? text.indexOf(keep) : -1;
  if (!keep || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="whitespace-nowrap">{keep}</span>
      {text.slice(at + keep.length)}
    </>
  );
}

/** One circled icon per step type, in the status colours (the icon step, ≥3:1 on the surface). */
const STEP_ICON: Record<LogType, { icon: IconSvgElement; className: string }> = {
  info: { icon: InformationCircleIcon, className: "text-muted-foreground" },
  ok: { icon: CircleCheckIcon, className: "text-success" },
  warn: { icon: AlertCircleIcon, className: "text-warning" },
  err: { icon: CircleXIcon, className: "text-destructive" },
};

/** Problem steps keep their readable status colour; the rest are plain text. */
const STEP_TEXT_CLASS: Record<LogType, string | undefined> = {
  info: undefined,
  ok: undefined,
  warn: "text-warning-foreground",
  err: "text-destructive-foreground",
};

/*
 * Fixed heights, so nothing moves between idle, running and done: the result card's body fits
 * the stat chips over a three-line well (a longer reply scrolls inside the well), and the step
 * list shows about four steps (more on a phone, where steps wrap) and scrolls. The result body
 * is `flex-none`: as a growing flex item of the card its basis would win over the height.
 */
const RESULT_HEIGHT = "h-44";
const STEPS_HEIGHT = "h-32 max-sm:h-40";

function defaultModel(models: string[]): string {
  if (models.length === 0 || models.includes(DEFAULT_TEST_MODEL)) return DEFAULT_TEST_MODEL;
  return models[0];
}

/** "1.2 s elapsed" since `started`, ticking every 100 ms (only this line re-renders). */
function Elapsed({ started }: { started: number }): JSX.Element {
  const { t } = useT("accounts");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums">
      {t("test.elapsed", { seconds: formatDecimal(Math.max(0, now - started) / 1000, 1) })}
    </span>
  );
}

/** The idle and running body: the empty-state tile, title and hint, centred in the card. */
function ResultState({
  media,
  title,
  description,
}: {
  media: JSX.Element;
  title: string;
  description: JSX.Element | string;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <EmptyHeader>
        <EmptyMedia className={EMPTY_SIZING.compact.media} variant="icon">
          {media}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </div>
  );
}

/** A small stat next to the result (latency, tokens, credits): an outline chip with a line icon. */
function StatChip({ icon, children }: { icon: IconSvgElement; children: string }): JSX.Element {
  return (
    <Badge icon={icon} iconStyle="line" size="sm" variant="outline">
      {children}
    </Badge>
  );
}

/**
 * One step of the timeline: its icon on the first line with a hairline down to the next step,
 * the text, and the time at the end. Memoised: a new step renders only itself, not the 100
 * before it.
 */
const Step = memo(function Step({ line }: { line: LogLine }): JSX.Element {
  const step = STEP_ICON[line.type];
  return (
    <li className="group flex gap-3" data-type={line.type}>
      <span aria-hidden="true" className="flex shrink-0 flex-col items-center">
        <span className="flex h-lh items-center">
          <HugeiconsIcon className={cn("size-4", step.className)} icon={step.icon} />
        </span>
        <span className="my-1 w-px flex-1 bg-border group-last:hidden" />
      </span>
      <span className="flex min-w-0 flex-1 gap-3 pb-3 group-last:pb-0">
        <span className={cn("min-w-0 flex-1 wrap-break-word", STEP_TEXT_CLASS[line.type])}>
          <LogText keep={line.keep} text={line.text} />
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{line.time}</span>
      </span>
    </li>
  );
});

/** Sends a real "say ok" request through one account and logs the outcome. Spends credits. */
export function TestAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const { t: tc } = useT();
  const displayEmail = useDisplayEmail();
  const maskText = useMaskText();
  const fieldId = useId();
  const stepsId = useId();

  const cached = useQuery({
    queryKey: queryKeys.accounts.modelsCached(account.id),
    queryFn: () => getAccountModelsCached(account.id),
    // The server answers lowercase ids in set order.
    select: (result) => [...result.models].sort(),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const models = cached.data ?? [];

  const [model, setModel] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // When the running test started; null while idle.
  const [started, setStarted] = useState<number | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const runningRef = useRef(false);
  const nextIdRef = useRef(0);
  const logRef = useRef<HTMLOListElement | null>(null);
  const running = started !== null;

  const modelValue = model ?? (cached.isPending ? "" : defaultModel(models));
  const email = displayEmail(account.email, account.id);
  const proxy = account.proxyURL || t("test.globalProxy");

  useEffect(() => {
    if (lines.length === 0) return;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  const append = (type: LogType, text: string, keep?: string) => {
    const line: LogLine = {
      id: nextIdRef.current++,
      time: formatClockTime(new Date()),
      type,
      text,
      keep,
    };
    setLines((current) => [...current, line].slice(-MAX_LOG_LINES));
  };

  const run = async () => {
    if (runningRef.current || cached.isPending) return;
    runningRef.current = true;
    const target = modelValue.trim() || DEFAULT_TEST_MODEL;
    const startedAt = Date.now();
    setStarted(startedAt);
    append("info", t("testLog.start", { email, model: target, proxy }), target);
    const seconds = () => formatDecimal((Date.now() - startedAt) / 1000, 1);
    try {
      const result = await testAccount(account.id, { model: target });
      const took = seconds();
      setOutcome({ kind: "ok", seconds: took, result });
      append("ok", t("testLog.success", { email, seconds: took, reply: result.reply }));
      append(
        "info",
        t("testLog.details", {
          stopReason: result.stopReason || t("testLog.noStopReason"),
          input: result.inputTokens,
          output: result.outputTokens,
          credits: result.credits,
          context: formatDecimal(Number(result.contextUsage), 1),
        }),
      );
      if (!result.stopReason) append("warn", t("testLog.noStopReasonHint"));
    } catch (error) {
      const took = seconds();
      const reason = maskText(errorMessage(error, t));
      setOutcome({ kind: "err", seconds: took, reason });
      append("err", t("testLog.failed", { email, seconds: took, reason }));
    } finally {
      runningRef.current = false;
      setStarted(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter picks a highlighted suggestion while the list is open; otherwise it runs the test.
    if (event.key !== "Enter" || suggestionsOpen) return;
    event.preventDefault();
    void run();
  };

  const status = cached.isPending
    ? t("test.modelsLoading")
    : cached.isError
      ? t("test.modelsFallback")
      : t("test.modelsReady", { count: models.length });

  return (
    <ResponsiveDialog
      description={t("test.hint")}
      footer={
        <Button onClick={() => onOpenChange(false)} variant="ghost">
          {tc("actions.close")}
        </Button>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="lg"
      title={t("test.title")}
    >
      <div className="flex flex-col gap-5">
        {/* Who the test runs as: the account and its state, then its plan, sign-in and proxy. */}
        <div className="flex min-w-0 items-center gap-3">
          <IconChip icon={UserCircleIcon} size="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <TruncatedText className="font-medium text-sm">{email}</TruncatedText>
              <StatusPill account={account} plain size="sm" />
            </div>
            <TruncatedText className="text-meta text-muted-foreground">
              {`${planLabel(account, t)} · ${authLabel(account, t)} · ${proxy}`}
            </TruncatedText>
          </div>
        </div>

        {/* The model and the Run button on one row, at one height. */}
        <Field>
          <FieldLabel htmlFor={fieldId}>{t("test.model")}</FieldLabel>
          <div className="flex w-full min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Autocomplete
                // A whole model id in the field (the default, or a pick) lists every cached model;
                // typing anything else filters the list as usual.
                filter={models.includes(modelValue) ? null : undefined}
                items={models}
                onOpenChange={setSuggestionsOpen}
                onValueChange={(value) => setModel(value)}
                openOnInputClick
                value={modelValue}
              >
                <AutocompleteInput
                  autoComplete="off"
                  disabled={cached.isPending}
                  id={fieldId}
                  onKeyDown={onKeyDown}
                  placeholder={t("test.modelPlaceholder")}
                  showTrigger={models.length > 0}
                  spellCheck={false}
                  // Its own name: inside a Field the trigger would take the field's label instead.
                  triggerProps={{
                    "aria-label": t("test.showModels"),
                    "aria-labelledby": undefined,
                  }}
                  variant="code"
                />
                <AutocompletePopup>
                  <AutocompleteEmpty>{t("test.noModelMatches")}</AutocompleteEmpty>
                  <AutocompleteList>
                    {(item: string) => (
                      <AutocompleteItem key={item} value={item}>
                        <ModelLogo model={item} />
                        <span className="font-mono text-meta">{item}</span>
                      </AutocompleteItem>
                    )}
                  </AutocompleteList>
                </AutocompletePopup>
              </Autocomplete>
            </div>
            {/* While it runs the spinner takes the icon's place and the label stays: no shift. */}
            <Button disabled={cached.isPending} loading={running} onClick={() => void run()}>
              <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
              {t("test.run")}
            </Button>
          </div>
          <FieldDescription
            aria-live="polite"
            className={cached.isError ? "text-warning-foreground" : undefined}
          >
            {status}
          </FieldDescription>
        </Field>

        <Card divided>
          <CardHeader>
            <CardHeading>
              <CardTitle render={(props) => <h3 {...props} />}>{t("test.result")}</CardTitle>
            </CardHeading>
            {/* The pill is the live part: "Running", then "Succeeded" or "Failed". */}
            <CardAction aria-live="polite">
              {running ? (
                <Badge live tone="info">
                  {t("test.status.running")}
                </Badge>
              ) : outcome?.kind === "ok" ? (
                <Badge icon={CircleCheckIcon} tone="success">
                  {t("test.status.ok")}
                </Badge>
              ) : outcome?.kind === "err" ? (
                <Badge icon={CircleXIcon} tone="destructive">
                  {t("test.status.failed")}
                </Badge>
              ) : null}
            </CardAction>
          </CardHeader>
          <CardPanel className={cn(RESULT_HEIGHT, "flex flex-none flex-col gap-3")}>
            {started !== null ? (
              <ResultState
                description={<Elapsed started={started} />}
                media={<Spinner aria-hidden="true" />}
                title={t("test.waitingTitle")}
              />
            ) : outcome?.kind === "ok" ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatChip icon={Timer01Icon}>
                    {t("test.seconds", { seconds: outcome.seconds })}
                  </StatChip>
                  <StatChip icon={ArrowDataTransferVerticalIcon}>
                    {t("test.tokens", {
                      input: formatNumber(outcome.result.inputTokens, lang),
                      output: formatNumber(outcome.result.outputTokens, lang),
                    })}
                  </StatChip>
                  <StatChip icon={Coins01Icon}>
                    {t("test.credits", {
                      credits: formatCreditsExact(outcome.result.credits, lang),
                    })}
                  </StatChip>
                  {/* The step list explains it (common on Enterprise accounts). */}
                  {outcome.result.stopReason ? null : (
                    <Badge icon={AlertCircleIcon} size="sm" tone="warning">
                      {t("test.noStopReason")}
                    </Badge>
                  )}
                </div>
                {/* The well fills the rest of the card and scrolls a long reply. */}
                <CodeBlock
                  className="min-h-0 flex-1"
                  code={outcome.result.reply}
                  copyLabel={t("test.copyReply")}
                  title={t("test.reply")}
                  wrap
                />
              </>
            ) : outcome?.kind === "err" ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatChip icon={Timer01Icon}>
                    {t("test.seconds", { seconds: outcome.seconds })}
                  </StatChip>
                </div>
                <CodeBlock
                  className="min-h-0 flex-1"
                  code={outcome.reason}
                  copyLabel={t("test.copyError")}
                  title={t("test.error")}
                  wrap
                />
              </>
            ) : (
              <ResultState
                description={t("test.idleHint")}
                media={<HugeiconsIcon icon={FlaskConicalIcon} aria-hidden="true" />}
                title={t("test.idleTitle")}
              />
            )}
          </CardPanel>
        </Card>

        {/* The steps of every run, oldest first: a quiet timeline with no frame of its own. */}
        <section aria-labelledby={stepsId} className="flex flex-col gap-2">
          <div className="flex min-h-8 items-center justify-between gap-2">
            <h3 className="font-medium text-foreground text-sm" id={stepsId}>
              {t("testLog.title")}
            </h3>
            <Button
              disabled={lines.length === 0}
              onClick={() => setLines([])}
              size="sm"
              variant="ghost"
            >
              {t("testLog.clear")}
            </Button>
          </div>
          {lines.length === 0 ? (
            <p
              className={cn(
                STEPS_HEIGHT,
                "flex items-center justify-center text-center text-muted-foreground text-sm",
              )}
            >
              {t("testLog.empty")}
            </p>
          ) : (
            <ol
              aria-label={t("testLog.title")}
              className={cn(
                STEPS_HEIGHT,
                "scrollbar-y scroll-fade-y flex flex-col overflow-y-auto font-mono text-meta leading-relaxed",
              )}
              ref={logRef}
              role="log"
            >
              {lines.map((line) => (
                <Step key={line.id} line={line} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </ResponsiveDialog>
  );
}

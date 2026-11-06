import {
  AlertCircleIcon,
  CircleCheckIcon,
  CircleXIcon,
  FlaskConicalIcon,
  InformationCircleIcon,
  PlayIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { EMPTY_SIZING } from "@/components/shared/empty-state";
import { IconChip } from "@/components/shared/icon-chip";
import { ModelLogo } from "@/components/shared/model-logo";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  CardDescription,
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
import {
  formatClockTime,
  formatCreditsExact,
  formatDecimal,
  formatFraction,
  formatNumber,
} from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail, useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { authLabel } from "./account-model";

/** The old UI's fallback when nothing is cached (the server's own default differs). */
export const DEFAULT_TEST_MODEL = "claude-sonnet-4.6";
export const MAX_LOG_LINES = 100;

export type LogType = "info" | "ok" | "warn" | "err";
interface LogLine {
  id: number;
  time: string;
  type: LogType;
  text: string;
  /** A model id inside `text` that must not wrap at its hyphens ("claude-" / "sonnet-4.6"). */
  keep?: string;
}

/** The latest run, for the result panel; the log keeps every run. */
type Outcome =
  | { kind: "ok"; model: string; seconds: string; result: TestAccountResponse }
  | { kind: "err"; model: string; seconds: string; reason: string };

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

/** One circled icon per line type, in the status colours (the icon tone, ≥3:1 on the card). */
const LOG_ICON: Record<LogType, { icon: IconSvgElement; className: string }> = {
  info: { icon: InformationCircleIcon, className: "text-muted-foreground" },
  ok: { icon: CircleCheckIcon, className: "text-success" },
  warn: { icon: AlertCircleIcon, className: "text-warning" },
  err: { icon: CircleXIcon, className: "text-destructive" },
};

/** Problem lines keep their readable status colour; the rest are plain text. */
const LOG_TEXT_CLASS: Record<LogType, string | undefined> = {
  info: undefined,
  ok: undefined,
  warn: "text-warning-foreground",
  err: "text-destructive-foreground",
};

/**
 * The log's fixed height, empty or full, so a run never moves what is below it: about five
 * lines, and more on a phone, where lines wrap and the sheet scrolls anyway.
 */
const LOG_HEIGHT = "min-h-28 max-h-28 max-sm:min-h-40 max-sm:max-h-40";

function defaultModel(models: string[]): string {
  if (models.length === 0 || models.includes(DEFAULT_TEST_MODEL)) return DEFAULT_TEST_MODEL;
  return models[0];
}

/** Seconds since `started` with one decimal, ticking every 100 ms; empty while it is null. */
function useElapsed(started: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (started === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [started]);
  return started === null ? "" : formatDecimal(Math.max(0, now - started) / 1000, 1);
}

/**
 * The run's figures in two columns at every width (the detail sheet's key-value look), so the
 * result keeps one height from a phone to a desktop.
 */
function Metrics({ items }: { items: { label: string; value: string }[] }): JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
      {items.map((item) => (
        <div className="flex min-w-0 flex-col gap-1" key={item.label}>
          <dt className="text-meta text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The idle and running states: the empty-state tile, title and hint, centred in the panel. */
function PanelState({
  media,
  title,
  description,
}: {
  media: JSX.Element;
  title: string;
  description: string;
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
  // The running model and its start time; null while idle.
  const [pending, setPending] = useState<{ model: string; started: number } | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const runningRef = useRef(false);
  const nextIdRef = useRef(0);
  const logRef = useRef<HTMLOListElement | null>(null);
  const elapsed = useElapsed(pending?.started ?? null);
  const running = pending !== null;

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
    const started = Date.now();
    setPending({ model: target, started });
    append("info", t("testLog.start", { email, model: target, proxy }), target);
    const seconds = () => formatDecimal((Date.now() - started) / 1000, 1);
    try {
      const result = await testAccount(account.id, { model: target });
      const took = seconds();
      setOutcome({ kind: "ok", model: target, seconds: took, result });
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
      setOutcome({ kind: "err", model: target, seconds: took, reason });
      append("err", t("testLog.failed", { email, seconds: took, reason }));
    } finally {
      runningRef.current = false;
      setPending(null);
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

  // The model the result panel talks about: the running one, else the last finished one.
  const shownModel = pending?.model ?? outcome?.model;
  // Its time: ticking while it runs, then the time the last run took.
  const shownSeconds = running ? elapsed : outcome?.seconds;

  return (
    <ResponsiveDialog
      description={t("test.hint")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.close")}
          </Button>
          <Button
            disabled={cached.isPending}
            loading={running}
            loadingText={t("test.running")}
            onClick={() => void run()}
          >
            <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
            {t("test.run")}
          </Button>
        </>
      }
      anchor="top"
      onOpenChange={onOpenChange}
      open={open}
      size="lg"
      title={t("test.title")}
    >
      <div className="flex flex-col gap-4">
        {/* Who the test runs as: the account, its sign-in and the proxy it goes through. */}
        <div className="flex min-w-0 items-center gap-3">
          <IconChip icon={UserCircleIcon} size="md" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <TruncatedText className="font-medium text-sm">{email}</TruncatedText>
            <TruncatedText className="text-meta text-muted-foreground">
              {`${authLabel(account, t)} · ${proxy}`}
            </TruncatedText>
          </div>
        </div>

        <Field>
          <FieldLabel htmlFor={fieldId}>{t("test.model")}</FieldLabel>
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
              triggerProps={{ "aria-label": t("test.showModels"), "aria-labelledby": undefined }}
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
          <FieldDescription
            aria-live="polite"
            className={cached.isError ? "text-warning-foreground" : undefined}
          >
            {status}
          </FieldDescription>
        </Field>

        <Card divided>
          <CardHeader>
            {/* Sized to its text, so the pill and the time stay on the title's line on a phone. */}
            <CardHeading className="basis-auto">
              <CardTitle render={(props) => <h3 {...props} />}>{t("test.result")}</CardTitle>
              {shownModel ? (
                // Phones drop it (the field above names the model), so the pill stays on the
                // title's line.
                <CardDescription
                  className="min-w-0 truncate font-mono max-sm:hidden"
                  variant="inline"
                >
                  {shownModel}
                </CardDescription>
              ) : null}
            </CardHeading>
            <CardAction>
              {/* The pill is the live part: "Running", then "Succeeded" or "Failed". */}
              <span aria-live="polite" className="flex">
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
              </span>
              {shownSeconds ? (
                <span className="text-meta text-muted-foreground tabular-nums">
                  {t("test.seconds", { seconds: shownSeconds })}
                </span>
              ) : null}
            </CardAction>
          </CardHeader>
          {/*
            One height for the idle, running and success states (the success layout's), so the
            dialog does not jump while a test runs; a long reply or error grows it.
          */}
          <CardPanel className="flex min-h-60 flex-col gap-4">
            {running ? (
              <PanelState
                description={t("test.waitingHint")}
                media={<Spinner aria-hidden="true" />}
                title={t("test.waitingTitle")}
              />
            ) : outcome?.kind === "ok" ? (
              <>
                <CodeBlock
                  code={outcome.result.reply}
                  copyLabel={t("test.copyReply")}
                  title={t("test.reply")}
                  wrap
                />
                <Metrics
                  items={[
                    {
                      label: t("test.stopReason"),
                      value: outcome.result.stopReason || t("testLog.noStopReason"),
                    },
                    {
                      label: t("test.tokens"),
                      value: `${formatNumber(outcome.result.inputTokens, lang)} / ${formatNumber(outcome.result.outputTokens, lang)}`,
                    },
                    {
                      label: t("test.credits"),
                      value: formatCreditsExact(outcome.result.credits, lang),
                    },
                    {
                      label: t("test.context"),
                      value: formatFraction(Number(outcome.result.contextUsage) / 100, 1, lang),
                    },
                  ]}
                />
                {outcome.result.stopReason ? null : (
                  <Alert size="sm" variant="warning">
                    <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
                    <AlertDescription>{t("testLog.noStopReasonHint")}</AlertDescription>
                  </Alert>
                )}
              </>
            ) : outcome?.kind === "err" ? (
              <>
                <CodeBlock
                  code={outcome.reason}
                  copyLabel={t("test.copyError")}
                  title={t("test.error")}
                  wrap
                />
                <p className="text-pretty text-muted-foreground text-sm leading-relaxed">
                  {t("test.failedHint")}
                </p>
              </>
            ) : (
              <PanelState
                description={t("test.idleHint")}
                media={<HugeiconsIcon icon={FlaskConicalIcon} aria-hidden="true" />}
                title={t("test.idleTitle")}
              />
            )}
          </CardPanel>
        </Card>

        <Card divided>
          <CardHeader>
            <CardHeading>
              <CardTitle render={(props) => <h3 {...props} />}>{t("testLog.title")}</CardTitle>
            </CardHeading>
            <CardAction>
              <Button
                disabled={lines.length === 0}
                onClick={() => setLines([])}
                size="sm"
                variant="ghost"
              >
                {t("testLog.clear")}
              </Button>
            </CardAction>
          </CardHeader>
          {lines.length === 0 ? (
            <CardPanel className={cn(LOG_HEIGHT, "text-muted-foreground text-sm")} render={<p />}>
              {t("testLog.empty")}
            </CardPanel>
          ) : (
            <CardPanel
              aria-label={t("testLog.title")}
              className={cn(
                LOG_HEIGHT,
                "scrollbar-y flex flex-col gap-1.5 overflow-y-auto font-mono text-meta tabular-nums leading-relaxed",
              )}
              render={<ol ref={logRef} />}
              role="log"
            >
              {lines.map((line) => {
                const icon = LOG_ICON[line.type];
                return (
                  // Icon and time are their own columns: a long line wraps under its text.
                  <li className="flex gap-2" data-type={line.type} key={line.id}>
                    <span className="flex h-lh shrink-0 items-center">
                      <HugeiconsIcon
                        aria-hidden="true"
                        className={cn("size-3.5", icon.className)}
                        icon={icon.icon}
                      />
                    </span>
                    <span className="shrink-0 text-muted-foreground">{line.time}</span>
                    <span className={cn("min-w-0 break-words", LOG_TEXT_CLASS[line.type])}>
                      <LogText keep={line.keep} text={line.text} />
                    </span>
                  </li>
                );
              })}
            </CardPanel>
          )}
        </Card>
      </div>
    </ResponsiveDialog>
  );
}

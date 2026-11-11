import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  CircleCheckIcon,
  CircleXIcon,
  InformationCircleIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, memo, useEffect, useId, useRef, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { CopyButton } from "@/components/shared/copy-button";
import { ModelLogo } from "@/components/shared/model-logo";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { getAccountModelsCached, testAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account, TestAccountResponse } from "@/lib/api/types";
import { EMPTY, formatClockTime, formatCreditsExact, formatDecimal } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail, useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { authLabel, planLabel } from "./account-model";
import { TestModelPicker } from "./test-model-picker";

/** The old UI's fallback when nothing is cached (the server's own default differs). */
const DEFAULT_TEST_MODEL = "claude-sonnet-4.6";
/** The steps kept per model; older ones drop off the top. */
export const MAX_LOG_LINES = 100;
/** How many models one batch tests at the same time; the rest wait their turn. */
const TEST_CONCURRENCY = 3;

type LogType = "info" | "ok" | "warn" | "err";
interface LogLine {
  id: number;
  time: string;
  type: LogType;
  text: string;
  /** A model id inside `text` that must not wrap at its hyphens ("claude-" / "sonnet-4.6"). */
  keep?: string;
}

/** One model's latest run. A model with no entry has not run yet. */
type ModelRun =
  | { kind: "queued" }
  | { kind: "running"; started: number }
  | { kind: "ok"; seconds: string; result: TestAccountResponse }
  | { kind: "err"; seconds: string; reason: string };

type DetailTab = "response" | "steps";

/*
 * One grid for the column heads and every row, so the columns line up: the model takes the rest,
 * then status, time, credits and the chevron. Phones keep the model, time and chevron: the
 * status moves under the name and the credits column goes, so the name is never cut.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_--spacing(12)_--spacing(16)_--spacing(4)] items-center gap-3 px-3 max-sm:grid-cols-[minmax(0,1fr)_--spacing(10)_--spacing(4)] max-sm:gap-2";
/** The open row's panel keeps one height across its tabs and states, so nothing below moves. */
const DETAIL_HEIGHT = "h-56";

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

function defaultModel(models: string[]): string {
  if (models.length === 0 || models.includes(DEFAULT_TEST_MODEL)) return DEFAULT_TEST_MODEL;
  return models[0];
}

/** Seconds since `started`, ticking every 100 ms (only this text re-renders). */
function Elapsed({
  started,
  format,
}: {
  started: number;
  format: (seconds: string) => string;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums">
      {format(formatDecimal(Math.max(0, now - started) / 1000, 1))}
    </span>
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

/** The Status cell: Not run, Queued, Running, Succeeded or Failed. */
function RunBadge({ run }: { run: ModelRun | undefined }): JSX.Element {
  const { t } = useT("accounts");
  if (!run) return <Badge size="sm">{t("test.status.notRun")}</Badge>;
  switch (run.kind) {
    case "queued":
      return <Badge size="sm">{t("test.status.queued")}</Badge>;
    case "running":
      return (
        <Badge live size="sm" tone="info">
          {t("test.status.running")}
        </Badge>
      );
    case "ok":
      return (
        <Badge icon={CircleCheckIcon} size="sm" tone="success">
          {t("test.status.ok")}
        </Badge>
      );
    case "err":
      return (
        <Badge icon={CircleXIcon} size="sm" tone="destructive">
          {t("test.status.failed")}
        </Badge>
      );
  }
}

/** A model as plain text: its logo and its id, with no chip around it. */
function ModelName({ model, className }: { model: string; className?: string }): JSX.Element {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <ModelLogo model={model} />
      <span className="truncate font-mono text-foreground text-meta">{model}</span>
    </span>
  );
}

/** The reply as the server sent it, less the `success` flag and an empty `reasoning`. */
function responseJson(result: TestAccountResponse): string {
  const { success: _success, reasoning, ...rest } = result;
  return JSON.stringify(reasoning ? { ...rest, reasoning } : rest, null, 2);
}

/** A quiet centred state inside the open row's panel: Not run yet, Queued or Waiting. */
function DetailState({
  icon,
  title,
  description,
}: {
  icon: JSX.Element;
  title: string;
  description: JSX.Element | string;
}): JSX.Element {
  return (
    <div
      className={cn(
        DETAIL_HEIGHT,
        "flex flex-col items-center justify-center gap-1 bg-surface-inset px-4 text-center",
      )}
    >
      <span className="mb-1 text-muted-foreground">{icon}</span>
      <span className="font-medium text-sm">{title}</span>
      <span className="text-meta text-muted-foreground">{description}</span>
    </div>
  );
}

/**
 * The tapped row's Response and Steps: the tabs, the model and a copy button on one strip, then
 * the raw response (or the error) as JSON, or that model's steps.
 */
function Inspector({
  id,
  model,
  run,
  steps,
  tab,
  onTabChange,
}: {
  id: string;
  model: string;
  run: ModelRun | undefined;
  steps: readonly LogLine[];
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const stepsRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    if (tab !== "steps" || steps.length === 0) return;
    const log = stepsRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [tab, steps]);

  const json =
    run?.kind === "ok"
      ? responseJson(run.result)
      : run?.kind === "err"
        ? JSON.stringify({ error: run.reason }, null, 2)
        : null;

  return (
    <section
      aria-label={model}
      className="overflow-hidden rounded-xl border border-border"
      data-slot="test-inspector"
      id={id}
    >
      <Tabs
        className="gap-0"
        onValueChange={(value) => onTabChange(value as DetailTab)}
        value={tab}
      >
        <div className="flex min-w-0 items-center gap-2 border-border-subtle border-b pe-1">
          <TabsList aria-label={model} className="border-b-0 px-1" size="sm" variant="underline">
            <TabsTab value="response">{t("test.response")}</TabsTab>
            <TabsTab value="steps">
              {t("testLog.title")}
              <Badge className="tabular-nums" size="sm">
                {steps.length}
              </Badge>
            </TabsTab>
          </TabsList>
          <ModelName className="ms-auto max-sm:hidden" model={model} />
          {json ? (
            <CopyButton
              className="max-sm:ms-auto"
              label={run?.kind === "err" ? t("test.copyError") : t("test.copyResponse")}
              size="icon-sm"
              value={json}
              variant="quiet"
            />
          ) : null}
        </div>
        <TabsPanel value="response">
          {run?.kind === "ok" && !run.result.stopReason ? (
            // The Steps tab explains it (common on Enterprise accounts).
            <div className="border-border-subtle border-b bg-surface-inset px-3 py-2">
              <Badge icon={AlertCircleIcon} size="sm" tone="warning">
                {t("test.noStopReason")}
              </Badge>
            </div>
          ) : null}
          {json ? (
            <CodeBlock
              bare
              className={cn(DETAIL_HEIGHT, "overflow-y-auto")}
              code={json}
              copyLabel={t("test.copyResponse")}
              language="json"
              title={t("test.response")}
              wrap
            />
          ) : run?.kind === "running" ? (
            <DetailState
              description={
                <Elapsed
                  format={(seconds) => t("test.elapsed", { seconds })}
                  started={run.started}
                />
              }
              icon={<Spinner aria-hidden="true" />}
              title={t("test.waitingTitle")}
            />
          ) : run?.kind === "queued" ? (
            <DetailState
              description={t("test.queuedHint")}
              icon={<HugeiconsIcon aria-hidden="true" className="size-5" icon={PlayIcon} />}
              title={t("test.status.queued")}
            />
          ) : (
            <DetailState
              description={t("test.notRunHint")}
              icon={<HugeiconsIcon aria-hidden="true" className="size-5" icon={PlayIcon} />}
              title={t("test.notRunTitle")}
            />
          )}
        </TabsPanel>
        <TabsPanel value="steps">
          {steps.length === 0 ? (
            <p
              className={cn(
                DETAIL_HEIGHT,
                "flex items-center justify-center bg-surface-inset px-4 text-center text-muted-foreground text-sm",
              )}
            >
              {t("testLog.empty")}
            </p>
          ) : (
            <ol
              aria-label={t("testLog.title")}
              className={cn(
                DETAIL_HEIGHT,
                "scrollbar-y flex flex-col overflow-y-auto bg-surface-inset p-3 font-mono text-meta leading-relaxed",
              )}
              ref={stepsRef}
              role="log"
            >
              {steps.map((line) => (
                <Step key={line.id} line={line} />
              ))}
            </ol>
          )}
        </TabsPanel>
      </Tabs>
    </section>
  );
}

/**
 * Sends a real "say ok" request through one account for each picked model, a few at a time, and
 * lists every model's outcome. Tapping a row opens its response and steps. Spends credits per
 * model.
 */
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
  const inspectorId = useId();
  const barRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Model names typed in by hand, after the cached ones.
  const [added, setAdded] = useState<string[]>([]);
  // The picked models; null until the first change, which means "just the default model".
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [runs, setRuns] = useState<Record<string, ModelRun>>({});
  const [steps, setSteps] = useState<Record<string, LogLine[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("response");
  const [batching, setBatching] = useState(false);
  const batchingRef = useRef(false);
  const nextIdRef = useRef(0);

  // Without a cached list the default model is still offered, so one tap tests it.
  const base = cached.isPending ? [] : models.length > 0 ? models : [DEFAULT_TEST_MODEL];
  const options = [...base, ...added.filter((model) => !base.includes(model))];
  const selected: ReadonlySet<string> =
    picked ?? new Set(cached.isPending ? [] : [defaultModel(models)]);
  const rows = options.filter((model) => selected.has(model));
  const openModel = expanded !== null && rows.includes(expanded) ? expanded : null;

  const email = displayEmail(account.email, account.id);
  const proxy = account.proxyURL || t("test.globalProxy");

  const setChecked = (model: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current ?? selected);
      if (checked) next.add(model);
      else next.delete(model);
      return next;
    });
  };
  const setMany = (models: readonly string[], checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current ?? selected);
      for (const model of models) {
        if (checked) next.add(model);
        else next.delete(model);
      }
      return next;
    });
  };
  const addModel = (model: string) => {
    if (!options.includes(model)) setAdded((current) => [...current, model]);
    setChecked(model, true);
  };

  const append = (model: string, type: LogType, text: string, keep?: string) => {
    const line: LogLine = {
      id: nextIdRef.current++,
      time: formatClockTime(new Date()),
      type,
      text,
      keep,
    };
    setSteps((current) => ({
      ...current,
      [model]: [...(current[model] ?? []), line].slice(-MAX_LOG_LINES),
    }));
  };
  const setRun = (model: string, run: ModelRun) =>
    setRuns((current) => ({ ...current, [model]: run }));

  const testOne = async (model: string) => {
    const startedAt = Date.now();
    setRun(model, { kind: "running", started: startedAt });
    append(model, "info", t("testLog.start", { email, model, proxy }), model);
    const seconds = () => formatDecimal((Date.now() - startedAt) / 1000, 1);
    try {
      const result = await testAccount(account.id, { model });
      const took = seconds();
      setRun(model, { kind: "ok", seconds: took, result });
      append(model, "ok", t("testLog.success", { email, seconds: took, reply: result.reply }));
      append(
        model,
        "info",
        t("testLog.details", {
          stopReason: result.stopReason || t("testLog.noStopReason"),
          input: result.inputTokens,
          output: result.outputTokens,
          credits: result.credits,
          context: formatDecimal(Number(result.contextUsage), 1),
        }),
      );
      if (!result.stopReason) append(model, "warn", t("testLog.noStopReasonHint"));
    } catch (error) {
      const took = seconds();
      const reason = maskText(errorMessage(error, t));
      setRun(model, { kind: "err", seconds: took, reason });
      append(model, "err", t("testLog.failed", { email, seconds: took, reason }));
    }
  };

  /** Tests the picked models, a few at a time; the rest show Queued until their turn. */
  const run = async () => {
    if (batchingRef.current || cached.isPending || rows.length === 0) return;
    batchingRef.current = true;
    setBatching(true);
    const queue = [...rows];
    setRuns((current) => {
      const next = { ...current };
      for (const model of queue) next[model] = { kind: "queued" };
      return next;
    });
    const worker = async () => {
      for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
        await testOne(model);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, () => worker()),
      );
    } finally {
      batchingRef.current = false;
      setBatching(false);
    }
  };

  const toggle = (model: string) => setExpanded((current) => (current === model ? null : model));

  // The status line over the rows, once any of them has run.
  const outcomes = rows.map((model) => runs[model]).filter((item) => item !== undefined);
  const succeeded = outcomes.filter((item) => item.kind === "ok");
  const failed = outcomes.filter((item) => item.kind === "err").length;
  const pending = outcomes.filter((item) => item.kind === "queued" || item.kind === "running");
  const credits = succeeded.reduce((total, item) => total + item.result.credits, 0);
  const times = succeeded.map((item) => Number(item.seconds)).sort((a, b) => a - b);
  const median = times.length > 0 ? times[Math.floor((times.length - 1) / 2)] : null;

  const status = cached.isPending
    ? t("test.modelsLoading")
    : cached.isError
      ? t("test.modelsFallback")
      : t("test.modelsReady", { count: models.length });

  return (
    <ResponsiveDialog
      description={`${email} · ${planLabel(account, t)} · ${authLabel(account, t)} · ${proxy}`}
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
      <div className="flex flex-col gap-3">
        {/* The request bar: the verb, the picked models as plain text, and the run button. */}
        <div
          className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input bg-field px-1 has-aria-expanded:border-ring"
          ref={barRef}
        >
          {/* Phones skip the verb, so the picked model's name keeps its room. */}
          <span className="flex h-7.5 shrink-0 items-center rounded-md bg-(--pill-primary-bg) px-2 font-medium font-mono text-(--pill-primary-fg) text-meta uppercase max-sm:hidden">
            {t("test.verb")}
          </span>
          <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
            <PopoverTrigger
              aria-label={t("test.pickModels")}
              className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 text-start outline-none focus-visible:outline-1 focus-visible:outline-ring disabled:cursor-default"
              disabled={cached.isPending}
            >
              {rows.length === 0 ? (
                <span className="truncate text-muted-foreground text-sm">
                  {cached.isPending ? t("test.modelsLoading") : t("test.noPicked")}
                </span>
              ) : (
                // The first pick in full, then how many more: a second name would only fit cut.
                <>
                  <ModelName model={rows[0]} />
                  {rows.length > 1 ? (
                    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                      {t("test.morePicked", { count: rows.length - 1 })}
                    </span>
                  ) : null}
                </>
              )}
              <HugeiconsIcon
                aria-hidden="true"
                className="ms-auto size-4 shrink-0 text-muted-foreground"
                icon={ArrowDown01Icon}
              />
            </PopoverTrigger>
            {/* As wide as the bar, hung just under it. */}
            <PopoverPopup
              align="start"
              anchor={barRef}
              className="w-(--anchor-width) rounded-xl"
              flush
              initialFocus={searchRef}
              sideOffset={6}
            >
              <TestModelPicker
                // Not while a batch runs: the bar's button shows it running.
                canRun={!cached.isPending && rows.length > 0 && !batching}
                count={rows.length}
                models={options}
                onAdd={addModel}
                onRun={() => {
                  setPickerOpen(false);
                  void run();
                }}
                onSet={setMany}
                onToggle={setChecked}
                picked={selected}
                runs={runs}
                searchRef={searchRef}
              />
            </PopoverPopup>
          </Popover>
          {/* While it runs the spinner takes the icon's place and the label stays: no shift. */}
          <Button
            disabled={cached.isPending || rows.length === 0}
            loading={batching}
            onClick={() => void run()}
            size="sm"
          >
            <HugeiconsIcon aria-hidden="true" icon={PlayIcon} />
            {t("test.runSelected", { count: rows.length })}
          </Button>
        </div>
        <p
          className={cn(
            "-mt-1 text-meta text-muted-foreground",
            cached.isError && "text-warning-foreground",
          )}
        >
          {`${status} · ${t("test.hint")}`}
        </p>

        {/* The status line, summed over the picked models. */}
        {outcomes.length > 0 ? (
          <p
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-meta text-muted-foreground tabular-nums"
          >
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              {t("test.summary.ok", { count: succeeded.length })}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
              {t("test.summary.failed", { count: failed })}
            </span>
            {pending.length > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                {t("test.summary.running", { count: pending.length })}
              </span>
            ) : null}
            {median !== null ? (
              <span>{t("test.summary.median", { seconds: formatDecimal(median, 1) })}</span>
            ) : null}
            <span>{t("test.credits", { credits: formatCreditsExact(credits, lang) })}</span>
          </p>
        ) : null}

        {/* One row per picked model; a tapped row opens below the list. */}
        <div className="overflow-hidden rounded-xl border border-border">
          <div
            aria-hidden="true"
            className={cn(
              ROW_GRID,
              "h-8 border-border-subtle border-b bg-(--row-head) text-meta text-muted-foreground",
            )}
          >
            <span>{t("test.column.model")}</span>
            <span className="max-sm:hidden">{t("test.column.status")}</span>
            <span className="text-end">{t("test.column.latency")}</span>
            <span className="text-end max-sm:hidden">{t("test.column.credits")}</span>
            <span />
          </div>
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-muted-foreground text-sm">
              {cached.isPending ? t("test.modelsLoading") : t("test.noRows")}
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {rows.map((model) => {
                const item = runs[model];
                const isOpen = openModel === model;
                return (
                  <li key={model}>
                    <button
                      aria-controls={isOpen ? inspectorId : undefined}
                      aria-expanded={isOpen}
                      className={cn(
                        "relative flex w-full cursor-pointer flex-col text-start outline-none hover:bg-(--row-hover) focus-visible:bg-(--row-hover) focus-visible:outline-1 focus-visible:outline-ring focus-visible:-outline-offset-1",
                        // The open row: tinted, with a short purple bar at its start edge.
                        isOpen &&
                          "bg-(--row-hover) before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-primary",
                      )}
                      data-model={model}
                      onClick={() => toggle(model)}
                      type="button"
                    >
                      <span className={cn(ROW_GRID, "min-h-10 w-full max-sm:py-2")}>
                        <span className="flex min-w-0 flex-col gap-1.5">
                          <ModelName model={model} />
                          <span className="flex ps-6 sm:hidden">
                            <RunBadge run={item} />
                          </span>
                        </span>
                        <span className="max-sm:hidden">
                          <RunBadge run={item} />
                        </span>
                        <span className="text-end text-meta tabular-nums">
                          {item?.kind === "running" ? (
                            <Elapsed
                              format={(seconds) => t("test.seconds", { seconds })}
                              started={item.started}
                            />
                          ) : item?.kind === "ok" || item?.kind === "err" ? (
                            t("test.seconds", { seconds: item.seconds })
                          ) : (
                            <span className="text-muted-foreground">{EMPTY}</span>
                          )}
                        </span>
                        <span className="text-end text-meta tabular-nums max-sm:hidden">
                          {item?.kind === "ok" ? (
                            formatCreditsExact(item.result.credits, lang)
                          ) : (
                            <span className="text-muted-foreground">{EMPTY}</span>
                          )}
                        </span>
                        <HugeiconsIcon
                          aria-hidden="true"
                          className={cn(
                            "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
                            isOpen && "rotate-90 text-foreground",
                          )}
                          icon={ArrowRight01Icon}
                        />
                      </span>
                      {item?.kind === "err" ? (
                        <span className="-mt-1 block ps-9 pe-3 pb-2.5 font-mono text-destructive-foreground text-meta leading-relaxed wrap-anywhere">
                          {item.reason}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {openModel ? (
          <Inspector
            id={inspectorId}
            model={openModel}
            onTabChange={setTab}
            run={runs[openModel]}
            steps={steps[openModel] ?? []}
            tab={tab}
          />
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

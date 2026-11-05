import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { getAccountModelsCached, testAccount } from "@/lib/api/accounts";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { Account } from "@/lib/api/types";
import { formatClockTime, formatDecimal } from "@/lib/format";
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

const LOG_CLASS: Record<LogType, string> = {
  info: "text-foreground",
  ok: "text-success-foreground",
  warn: "text-warning-foreground",
  err: "text-destructive-foreground",
};

function defaultModel(models: string[]): string {
  if (models.length === 0 || models.includes(DEFAULT_TEST_MODEL)) return DEFAULT_TEST_MODEL;
  return models[0];
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
  const { t } = useT("accounts");
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
  const [running, setRunning] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const runningRef = useRef(false);
  const nextIdRef = useRef(0);
  const logRef = useRef<HTMLOListElement | null>(null);

  const modelValue = model ?? (cached.isPending ? "" : defaultModel(models));

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
    setRunning(true);
    const email = displayEmail(account.email, account.id);
    const proxy = account.proxyURL || t("test.globalProxy");
    const target = modelValue.trim() || DEFAULT_TEST_MODEL;
    append("info", t("testLog.start", { email, model: target, proxy }), target);
    const started = Date.now();
    const seconds = () => formatDecimal((Date.now() - started) / 1000, 1);
    try {
      const result = await testAccount(account.id, { model: target });
      append("ok", t("testLog.success", { email, seconds: seconds(), reply: result.reply }));
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
      append(
        "err",
        t("testLog.failed", {
          email,
          seconds: seconds(),
          reason: maskText(errorMessage(error, t)),
        }),
      );
    } finally {
      runningRef.current = false;
      setRunning(false);
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
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {tc("actions.close")}
          </Button>
          <Button
            aria-busy={running || undefined}
            disabled={cached.isPending || running}
            onClick={() => void run()}
          >
            <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
            {running ? t("test.running") : t("test.run")}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="lg"
      title={t("test.title")}
    >
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate font-medium text-sm">{displayEmail(account.email, account.id)}</p>
          <p className="truncate text-muted-foreground text-xs">
            {authLabel(account, t)} · {account.proxyURL || t("test.globalProxy")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm" htmlFor={fieldId}>
            {t("test.model")}
          </label>
          <Autocomplete
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
              triggerProps={{ "aria-label": t("test.showModels") }}
            />
            <AutocompletePopup>
              <AutocompleteEmpty>{t("test.noModelMatches")}</AutocompleteEmpty>
              <AutocompleteList>
                {(item: string) => (
                  <AutocompleteItem key={item} value={item}>
                    {item}
                  </AutocompleteItem>
                )}
              </AutocompleteList>
            </AutocompletePopup>
          </Autocomplete>
          <p
            aria-live="polite"
            className={cn(
              "text-xs",
              cached.isError ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {status}
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h3 className="font-medium text-sm">{t("testLog.title")}</h3>
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
            <p className="px-3 pb-3 text-muted-foreground text-sm">{t("testLog.empty")}</p>
          ) : (
            <ol
              aria-label={t("testLog.title")}
              className="max-h-64 overflow-y-auto px-3 pb-3 text-xs leading-relaxed"
              ref={logRef}
              role="log"
            >
              {lines.map((line) => (
                <li
                  className={cn("break-words", LOG_CLASS[line.type])}
                  data-type={line.type}
                  key={line.id}
                >
                  <span className="me-2 text-muted-foreground">{line.time}</span>
                  <LogText keep={line.keep} text={line.text} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
}

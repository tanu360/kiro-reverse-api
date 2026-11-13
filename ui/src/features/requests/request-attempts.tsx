import { Route01Icon } from "@hugeicons/core-free-icons";
import type { JSX } from "react";
import { DisplayEmail } from "@/components/shared/display-email";
import { SectionCard } from "@/components/shared/section-card";
import { StatusDot } from "@/components/shared/status-dot";
import type { RequestAttempt } from "@/lib/api/types";
import { EMPTY, formatDurationMs, formatNumber } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ErrorTypeLabel } from "./error-type-badge";
import { attemptProxyText } from "./proxy-failure";

/** The endpoint an MCP web search attempt reports; it never reaches a Kiro chat endpoint. */
const WEB_SEARCH = "web_search";

/**
 * The request's upstream attempts as a short vertical timeline, oldest first: a green or red
 * dot on a hairline rail, then the account and the attempt's duration, then the Kiro endpoint,
 * when it started and its result. A failure adds its error text (emails masked under privacy
 * mode) and what came next: another account (failover), the same account again, or nothing
 * because output had already started. A failure at an outbound proxy is worded from its code,
 * in the viewer's language, never with Go's text. Rows logged before the chain existed have none,
 * and the card is not drawn.
 */
export function AttemptsCard({ attempts }: { attempts?: RequestAttempt[] }): JSX.Element | null {
  const { t, lang } = useT("requests");
  if (!attempts?.length) return null;
  const skipped = attempts.at(-1)?.skipped ?? 0;
  return (
    <SectionCard
      icon={Route01Icon}
      meta={formatNumber(attempts.length + skipped, lang)}
      slim
      title={t("attempts.title")}
    >
      <ol className="px-4 py-4 sm:px-6">
        {attempts.flatMap((attempt, index) => {
          const item = (
            <AttemptItem
              attempt={attempt}
              index={index}
              // biome-ignore lint/suspicious/noArrayIndexKey: the chain never reorders; its position is its identity
              key={`attempt-${index + 1}`}
              // The attempt that followed was dropped by the cap: what came next is unknown.
              next={index === attempts.length - 2 && skipped > 0 ? undefined : attempts[index + 1]}
            />
          );
          return index === attempts.length - 1 && skipped > 0
            ? [<SkippedItem count={skipped} key="skipped" />, item]
            : [item];
        })}
      </ol>
    </SectionCard>
  );
}

function AttemptItem({
  attempt,
  index,
  next,
}: {
  attempt: RequestAttempt;
  index: number;
  next?: RequestAttempt;
}): JSX.Element {
  const { t, lang } = useT("requests");
  const maskText = useMaskText();
  const message = attempt.success
    ? ""
    : attempt.proxy
      ? attemptProxyText(attempt.proxy, t)
      : maskText(attempt.message);
  const notes = attemptNotes(attempt, next, t);
  return (
    <li className="group flex gap-3" data-success={attempt.success} data-testid="request-attempt">
      <Rail tone={attempt.success ? "success" : "destructive"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pb-4 group-last:pb-0">
        <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
          <span className="min-w-0 font-medium">
            <span className="sr-only">{t("attempts.item", { index: index + 1 })} </span>
            <DisplayEmail email={attempt.email} id={attempt.accountId} />
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatDurationMs(attempt.durationMs, true, lang)}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
          <span className="min-w-0 wrap-anywhere">{attemptEndpoint(attempt.endpoint, t)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {t("attempts.startOffset", { offset: formatDurationMs(attempt.startMs, true, lang) })}
          </span>
          <span aria-hidden="true">·</span>
          <AttemptResult attempt={attempt} />
        </div>
        {message ? (
          <p className="whitespace-pre-wrap text-meta text-muted-foreground wrap-anywhere">
            {message}
          </p>
        ) : null}
        {notes.length > 0 ? <p className="text-meta">{notes.join(" · ")}</p> : null}
      </div>
    </li>
  );
}

/** Before the last attempt: how many attempts the 10-attempt cap left out between. */
function SkippedItem({ count }: { count: number }): JSX.Element {
  const { t } = useT("requests");
  return (
    <li className="group flex gap-3">
      <Rail tone="muted" />
      <p className="min-w-0 flex-1 pb-4 text-meta text-muted-foreground">
        {t("attempts.skipped", { count })}
      </p>
    </li>
  );
}

/** The dot on the first line, with a hairline down to the next item (none after the last). */
function Rail({ tone }: { tone: "success" | "destructive" | "muted" }): JSX.Element {
  return (
    <span aria-hidden="true" className="flex shrink-0 flex-col items-center">
      <span className="flex h-5 items-center">
        <StatusDot tone={tone} />
      </span>
      <span className="my-1 w-px flex-1 bg-border group-last:hidden" />
    </span>
  );
}

/** "Succeeded", or the error's category and its HTTP status. */
function AttemptResult({ attempt }: { attempt: RequestAttempt }): JSX.Element {
  const { t } = useT("requests");
  if (attempt.success) return <span>{t("ok")}</span>;
  const status = attempt.status ? ` ${attempt.status}` : "";
  return (
    <span className="inline-flex min-w-0 items-center gap-1 tabular-nums">
      {attempt.errorType ? <ErrorTypeLabel type={attempt.errorType} /> : t("fail")}
      {status}
    </span>
  );
}

function attemptEndpoint(endpoint: string | undefined, t: TFunction): string {
  if (endpoint === WEB_SEARCH) return t("attempts.webSearch");
  return endpoint || EMPTY;
}

/**
 * What a failed attempt led to. The server flags a failover; another try on the same account for
 * the same job reads as a retry, unless the job gave up and the next attempt is other work. Output
 * that had already started is said either way.
 */
function attemptNotes(
  attempt: RequestAttempt,
  next: RequestAttempt | undefined,
  t: TFunction,
): string[] {
  if (attempt.success) return [];
  const notes: string[] = [];
  if (attempt.midStream) notes.push(t("attempts.midStream"));
  if (attempt.failover) {
    notes.push(t("attempts.failover"));
  } else if (
    next &&
    !attempt.gaveUp &&
    next.accountId === attempt.accountId &&
    (next.endpoint === WEB_SEARCH) === (attempt.endpoint === WEB_SEARCH)
  ) {
    notes.push(t("attempts.retried"));
  }
  return notes;
}

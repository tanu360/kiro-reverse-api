import type { JSX, MouseEvent } from "react";
import { StatStrip } from "@/components/shared/stat-strip";
import { badgeVariants } from "@/components/ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type AccountActivityView, useAccountActivity } from "@/lib/api/account-activity";
import { EMPTY, formatDuration, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Why the pool skips the account: the limit, and that every try counts against it. */
function atLimitHint(activity: AccountActivityView, t: TFunction, lang: Lang): string {
  return t("live.atLimitHint", {
    count: activity.rpmLimit,
    limit: formatNumber(activity.rpmLimit, lang),
  });
}

/** Why the pool skips the account for now, and when it takes it back. */
function cooldownHint(activity: AccountActivityView, t: TFunction, lang: Lang): string {
  return t("live.coolingDownHint", { time: formatDuration(activity.cooldownSeconds, lang) });
}

/** The account's hold, if any: a cooldown wins over the RPM limit, it lasts longer. */
function skipReason(activity: AccountActivityView): "cooling" | "limit" | null {
  if (activity.cooldownSeconds > 0) return "cooling";
  return activity.atLimit ? "limit" : null;
}

/** The full sentence behind the short line: the tooltip and what a screen reader reads. */
function activitySentence(activity: AccountActivityView, t: TFunction, lang: Lang): string {
  const numbers = t("live.description", {
    count: activity.rpm,
    rpm: formatNumber(activity.rpm, lang),
    today: formatNumber(activity.today, lang),
  });
  const reason = skipReason(activity);
  if (reason === "cooling") return `${cooldownHint(activity, t, lang)} ${numbers}`;
  if (reason === "limit") return `${atLimitHint(activity, t, lang)} ${numbers}`;
  return numbers;
}

// A tap or click on the hint must not also open the account sheet under it (a table row or a
// card's open button).
const keepToHint = (event: MouseEvent) => event.stopPropagation();

/**
 * "At limit" or "Cooling down" with its reason: a popover, not a tooltip, so it opens on tap and
 * from the keyboard too. It sits above a card's open button (z-1).
 */
function SkipHint({
  label,
  hint,
  badge = false,
}: {
  label: string;
  hint: string;
  badge?: boolean;
}): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        className={
          badge
            ? badgeVariants({ size: "sm", tone: "warning" })
            : "touch-hit relative z-1 cursor-pointer rounded-sm text-warning-foreground outline-none focus-outline"
        }
        closeDelay={100}
        delay={200}
        onClick={keepToHint}
        openOnHover
        render={<button type="button" />}
      >
        {label}
        {/* A badge stands alone, so it reads its reason; the line's sentence already has it. */}
        {badge ? <span className="sr-only">{hint}</span> : null}
      </PopoverTrigger>
      <PopoverPopup className="max-w-72" tooltipStyle>
        {hint}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * One muted 12 px line: the account's requests in the last minute and since midnight. While the
 * pool skips the account it reads "At limit" (the per-account RPM limit) or "Cooling down" (after
 * errors) in the warning colour, a button that explains why. The full sentence is a tooltip and
 * the screen reader text. A dash holds the line while the first poll loads; nothing shows when it
 * fails, and a failed refresh keeps the last numbers.
 */
export function AccountActivityLine({
  accountId,
  className,
}: {
  accountId: string;
  /** Layout only (a line height that matches the surrounding rows). */
  className?: string;
}): JSX.Element | null {
  const { t, lang } = useT("accounts");
  const query = useAccountActivity(accountId);
  const line = cn(
    "flex min-w-0 items-center text-meta text-muted-foreground tabular-nums leading-tight",
    className,
  );
  const activity = query.data;
  if (!activity) {
    if (query.isError) return null;
    return (
      <span className={line} data-slot="account-activity">
        {EMPTY}
      </span>
    );
  }
  const today = t("live.todayShort", { today: formatNumber(activity.today, lang) });
  const sentence = activitySentence(activity, t, lang);
  const reason = skipReason(activity);
  if (reason) {
    return (
      <span
        className={line}
        data-at-limit={activity.atLimit ? "" : undefined}
        data-cooling={reason === "cooling" ? "" : undefined}
        data-slot="account-activity"
      >
        {/* Inline, not flex: the space around the separator stays. */}
        <span className="min-w-0 truncate">
          {reason === "cooling" ? (
            <SkipHint hint={cooldownHint(activity, t, lang)} label={t("live.coolingDown")} />
          ) : (
            <SkipHint hint={atLimitHint(activity, t, lang)} label={t("live.atLimit")} />
          )}
          <span aria-hidden="true">
            {" · "}
            {today}
          </span>
        </span>
        <span className="sr-only">{sentence}</span>
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={line} />}>
        <span aria-hidden="true" className="truncate" data-slot="account-activity">
          {t("live.rpmShort", { rpm: formatNumber(activity.rpm, lang) })}
          {" · "}
          {today}
        </span>
        <span className="sr-only">{sentence}</span>
      </TooltipTrigger>
      <TooltipPopup>{sentence}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The detail sheet's live numbers: requests today and in the last minute (against the limit
 * when one is set), with an "At limit" or "Cooling down" pill while the pool skips the account.
 * Left out when the first poll fails (the lifetime numbers below still stand); a failed refresh
 * keeps the last.
 */
export function LiveActivityStrip({
  accountId,
  className,
}: {
  accountId: string;
  /** Layout classes (a top hairline under content above it). */
  className?: string;
}): JSX.Element | null {
  const { t, lang } = useT("accounts");
  const query = useAccountActivity(accountId);
  const activity = query.data;
  if (!activity && query.isError) return null;
  let rpm: JSX.Element | string = EMPTY;
  if (activity) {
    const value =
      activity.rpmLimit > 0
        ? t("live.rpmOfLimit", {
            rpm: formatNumber(activity.rpm, lang),
            limit: formatNumber(activity.rpmLimit, lang),
          })
        : formatNumber(activity.rpm, lang);
    const reason = skipReason(activity);
    //! The limit counts every try, the number beside it only finished requests: the hint says why "0 / 1" can be at the limit.
    rpm = reason ? (
      <span className="inline-flex flex-wrap items-center gap-2">
        {value}
        {reason === "cooling" ? (
          <SkipHint badge hint={cooldownHint(activity, t, lang)} label={t("live.coolingDown")} />
        ) : (
          <SkipHint badge hint={atLimitHint(activity, t, lang)} label={t("live.atLimit")} />
        )}
      </span>
    ) : (
      value
    );
  }
  return (
    <StatStrip
      className={className}
      items={[
        { label: t("live.today"), value: activity ? formatNumber(activity.today, lang) : EMPTY },
        { label: t("live.rpm"), value: rpm },
      ]}
    />
  );
}

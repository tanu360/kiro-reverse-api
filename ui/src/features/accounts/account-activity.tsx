import type { JSX } from "react";
import { StatStrip } from "@/components/shared/stat-strip";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type AccountActivityView, useAccountActivity } from "@/lib/api/account-activity";
import { EMPTY, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Why the pool skips the account: the limit, and that every try counts against it. */
function atLimitHint(activity: AccountActivityView, t: TFunction, lang: Lang): string {
  return t("live.atLimitHint", {
    count: activity.rpmLimit,
    limit: formatNumber(activity.rpmLimit, lang),
  });
}

/** The full sentence behind the short line: the tooltip and what a screen reader reads. */
function activitySentence(activity: AccountActivityView, t: TFunction, lang: Lang): string {
  const numbers = t("live.description", {
    count: activity.rpm,
    rpm: formatNumber(activity.rpm, lang),
    today: formatNumber(activity.today, lang),
  });
  if (!activity.atLimit) return numbers;
  return `${atLimitHint(activity, t, lang)} ${numbers}`;
}

/**
 * One muted 12 px line: the account's requests in the last minute and since midnight, or "At
 * limit" in the warning colour while the pool skips it for the per-account RPM limit. The full
 * sentence is a tooltip and the screen reader text. A dash holds the line while the first poll
 * loads; nothing shows when it fails, and a failed refresh keeps the last numbers.
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={line} data-at-limit={activity.atLimit ? "" : undefined} />}
      >
        <span aria-hidden="true" className="truncate" data-slot="account-activity">
          {activity.atLimit ? (
            <span className="text-warning-foreground">{t("live.atLimit")}</span>
          ) : (
            t("live.rpmShort", { rpm: formatNumber(activity.rpm, lang) })
          )}
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
 * when one is set), with an "At limit" pill while the pool skips the account. Left out when the
 * first poll fails (the lifetime numbers below still stand); a failed refresh keeps the last.
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
    //! The limit counts every try, the number beside it only finished requests: the hint says why "0 / 1" can be at the limit.
    const hint = atLimitHint(activity, t, lang);
    rpm = activity.atLimit ? (
      <span className="inline-flex items-center gap-2">
        {value}
        <Tooltip>
          <TooltipTrigger render={<Badge size="sm" tone="warning" />}>
            {t("live.atLimit")}
            <span className="sr-only">{hint}</span>
          </TooltipTrigger>
          <TooltipPopup>{hint}</TooltipPopup>
        </Tooltip>
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

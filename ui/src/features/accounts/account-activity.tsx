import { Time04Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { JSX, MouseEvent } from "react";
import { StatStrip } from "@/components/shared/stat-strip";
import { BadgeIcon, type BadgeProps, badgeVariants } from "@/components/ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { type AccountActivityView, useAccountActivity } from "@/lib/api/account-activity";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatDuration, formatNumber } from "@/lib/format";
import { type Lang, type TFunction, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StatusPill } from "./account-cells";
import { accountStatus } from "./account-model";

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
  icon,
  size = "sm",
}: {
  label: string;
  hint: string;
  badge?: boolean;
  /** A badge's leading icon, as the status pills have. */
  icon?: IconSvgElement;
  size?: BadgeProps["size"];
}): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        className={
          badge
            ? cn(badgeVariants({ size, tone: "warning" }), "relative z-1 cursor-pointer")
            : "touch-hit relative z-1 cursor-pointer rounded-sm text-warning-foreground focus-outline"
        }
        closeDelay={100}
        delay={200}
        onClick={keepToHint}
        openOnHover
        render={<button type="button" />}
      >
        {badge && icon ? <BadgeIcon icon={icon} /> : null}
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
 * The account's status pill, live. While the pool skips an active account after errors it reads
 * "Cooling down" in the warning tone, not Active: a button whose hint says when the account is
 * back in rotation (the activity line under it shows the time left). Any other status is the
 * plain StatusPill.
 */
export function LiveStatusPill({
  account,
  plain,
  size,
}: {
  account: Account;
  /** StatusPill `plain`: no ban reason tooltip. */
  plain?: boolean;
  size?: BadgeProps["size"];
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const activity = useAccountActivity(account.id).data;
  const active = accountStatus(account, Math.floor(Date.now() / 1000)) === "active";
  if (activity && activity.cooldownSeconds > 0 && active) {
    return (
      <SkipHint
        badge
        hint={cooldownHint(activity, t, lang)}
        icon={Time04Icon}
        label={t("live.coolingDown")}
        size={size}
      />
    );
  }
  return <StatusPill account={account} plain={plain} size={size} />;
}

/**
 * One muted 12 px line: the account's requests in the last minute and since midnight. While the
 * pool skips the account for its per-account RPM limit it reads "At limit" in the warning colour,
 * a button that explains why; while it cools down after errors it starts with the time left (the
 * status pill above says "Cooling down" and explains). The full sentence is a tooltip and the
 * screen reader text. A dash holds the line while the first poll loads; nothing shows when it
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
  if (reason === "limit") {
    return (
      <span className={line} data-at-limit="" data-slot="account-activity">
        {/* Inline, not flex: the space around the separator stays. */}
        <span className="min-w-0 truncate">
          <SkipHint hint={atLimitHint(activity, t, lang)} label={t("live.atLimit")} />
          <span aria-hidden="true">
            {" · "}
            {today}
          </span>
        </span>
        <span className="sr-only">{sentence}</span>
      </span>
    );
  }
  const cooling = reason === "cooling";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={line} data-cooling={cooling ? "" : undefined} />}>
        {/* The cooling line may wrap at the separator rather than cut its time or count. */}
        <span
          aria-hidden="true"
          className={cooling ? "min-w-0 whitespace-normal" : "truncate"}
          data-slot="account-activity"
        >
          {cooling ? (
            <span className="whitespace-nowrap text-warning-foreground">
              {t("live.cooldownLeft", { time: formatDuration(activity.cooldownSeconds, lang) })}
            </span>
          ) : (
            t("live.rpmShort", { rpm: formatNumber(activity.rpm, lang) })
          )}
          {" · "}
          {cooling ? <span className="whitespace-nowrap">{today}</span> : today}
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

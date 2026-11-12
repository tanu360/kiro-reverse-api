import {
  AlertCircleIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  CircleXIcon,
  Clock01Icon,
  HourglassIcon,
  KeyRoundIcon,
  PauseCircleIcon,
  UserIcon,
  WeightIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentType, JSX, ReactNode } from "react";
import { AwsLogo, GithubLogo, GoogleLogo, MicrosoftLogo } from "@/components/shared/brand-logos";
import { RelativeTime } from "@/components/shared/relative-time";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge, type BadgeProps, type BadgeTone } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterLabel, MeterTrack } from "@/components/ui/meter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatFraction } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import type { AccountStatus } from "@/routes/-search";
import {
  accountStatus,
  authKey,
  authLabel,
  creditTone,
  formatCreditAmount,
  formatTokenExpiry,
  isApiKeyAccount,
  isHeld,
  overageEnabled,
  planLabel,
  tokenExpiry,
  trialExpiry,
  usagePercent,
} from "./account-model";
import { TagBadges } from "./account-tags";

/**
 * The one coloured pill of a row. Colour carries the meaning: red stops the account (a ban, no
 * token, no credits left), orange needs attention, grey is the admin's own switch, green is
 * healthy.
 */
const STATUS_PILL: Record<AccountStatus, { tone: BadgeTone; icon: IconSvgElement }> = {
  banned: { tone: "destructive", icon: CircleXIcon },
  suspended: { tone: "warning", icon: PauseCircleIcon },
  noToken: { tone: "destructive", icon: CircleMinusIcon },
  outOfCredits: { tone: "destructive", icon: AlertCircleIcon },
  expired: { tone: "warning", icon: Clock01Icon },
  disabled: { tone: "neutral", icon: CircleSlashIcon },
  active: { tone: "success", icon: CircleCheckIcon },
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The row's status pill; a ban reason, when the server sent one, is its tooltip. `plain` drops
 * the tooltip where the reason is already written next to the pill (the detail sheet).
 */
export function StatusPill({
  account,
  plain = false,
  size,
}: {
  account: Account;
  plain?: boolean;
  /** The Badge size; `sm` on the phone cards' meta line. */
  size?: BadgeProps["size"];
}): JSX.Element {
  const { t } = useT("accounts");
  const status = accountStatus(account, nowSec());
  const pill = STATUS_PILL[status];
  // The pool also writes a reason when it switches an account off (banStatus DISABLED).
  const held = status === "banned" || status === "suspended" || status === "disabled";
  const reason = !plain && held && isHeld(account) ? account.banReason : "";
  const label = t(`health.${status}`);
  if (!reason) {
    return (
      <Badge data-status={status} icon={pill.icon} size={size} tone={pill.tone}>
        {label}
      </Badge>
    );
  }
  return (
    <Tooltip>
      {/* Not a tab stop: the reason is also in the detail sheet. */}
      <TooltipTrigger
        render={<Badge data-status={status} icon={pill.icon} size={size} tone={pill.tone} />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The name a list shows for an account: the email (masked under privacy), or for an account
 * without one (an API key, an id) that id, set in mono like every other id.
 */
export function useAccountName(): (account: Account) => { text: string; mono: boolean } {
  const displayEmail = useDisplayEmail();
  return (account) => ({
    text: displayEmail(account.email, account.id),
    mono: isApiKeyAccount(account) || !account.email,
  });
}

/** The account's name cut to its column, with the full text as a tooltip only when cut off. */
function AccountName({ account }: { account: Account }): JSX.Element {
  const name = useAccountName()(account);
  return (
    // The mono id keeps the email's 14 px line, so every row is the same height.
    <TruncatedText className={cn("font-medium", name.mono && "font-mono text-meta leading-3.5")}>
      {name.text}
    </TruncatedText>
  );
}

/** A small muted icon with its meaning as a tooltip and as screen reader text. */
function Flag({ icon: Icon, label }: { icon: IconSvgElement; label: string }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" />}>
        <HugeiconsIcon icon={Icon} aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function trialHint(account: Account, t: ReturnType<typeof useT>["t"]): string | undefined {
  const expiry = trialExpiry(account.trialExpiresAt, Date.now());
  if (expiry?.kind === "expired") return t("trialExpired");
  if (expiry?.kind === "today") return t("trialToday");
  if (expiry?.kind === "days") return t("trialDays", { days: expiry.days });
  return undefined;
}

/** Weight, an active trial and overage, as quiet icons after the email. Nothing when plain. */
export function AccountFlags({ account }: { account: Account }): JSX.Element | null {
  const { t } = useT("accounts");
  const flags: ReactNode[] = [];
  if (account.weight >= 2) {
    flags.push(
      <Flag icon={WeightIcon} key="weight" label={t("weightShort", { weight: account.weight })} />,
    );
  }
  if (account.trialStatus === "ACTIVE" && account.trialUsageLimit > 0) {
    const hint = trialHint(account, t);
    flags.push(
      <Flag
        icon={HourglassIcon}
        key="trial"
        label={hint ? `${t("trial")} · ${hint}` : t("trial")}
      />,
    );
  }
  if (overageEnabled(account)) {
    flags.push(<Flag icon={ZapIcon} key="overage" label={t("overageOn")} />);
  }
  if (flags.length === 0) return null;
  return <span className="flex shrink-0 items-center gap-1.5">{flags}</span>;
}

/**
 * Plan and sign-in method as one muted line ("Team primary · Pro · Builder ID"). Pass
 * `withAuth: false` where an AuthIcon already names the method.
 */
export function accountMeta(
  account: Account,
  t: ReturnType<typeof useT>["t"],
  withAuth = true,
): string {
  return [account.nickname, planLabel(account, t), withAuth ? authLabel(account, t) : ""]
    .filter((part) => part && part !== EMPTY)
    .join(" · ");
}

const AUTH_LOGOS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  google: GoogleLogo,
  github: GithubLogo,
  builderId: AwsLogo,
  enterprise: AwsLogo,
  microsoft: MicrosoftLogo,
};

/** Whether AuthIcon draws a mark for this account's sign-in method. */
export function hasAuthIcon(account: Account): boolean {
  const key = authKey(account);
  return key === "apiKey" || key in AUTH_LOGOS;
}

/**
 * Whether the mark alone names the method, so the meta line can leave the word out. Builder ID
 * and Enterprise share the AWS mark, so they keep their word.
 */
export function authIconNamesMethod(account: Account): boolean {
  return hasAuthIcon(account) && AUTH_LOGOS[authKey(account)] !== AwsLogo;
}

/**
 * The sign-in method's mark (Google, GitHub, AWS for Builder ID and Enterprise, Microsoft, a key
 * for API keys) after the email, with the method's name as a tooltip and as screen reader text.
 * Nothing for a method without a mark: the meta line names it in words instead.
 */
export function AuthIcon({ account }: { account: Account }): JSX.Element | null {
  const { t } = useT("accounts");
  const key = authKey(account);
  const Logo = AUTH_LOGOS[key];
  let mark: JSX.Element;
  if (key === "apiKey") {
    mark = (
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground"
        icon={KeyRoundIcon}
      />
    );
  } else if (Logo) {
    // The AWS wordmark fills less of its square than a glyph does: drawn larger, the negative
    // margin keeps its footprint at size-3.5.
    mark = <Logo className={Logo === AwsLogo ? "-m-0.5 size-4.5" : "size-3.5"} />;
  } else {
    return null;
  }
  const label = authLabel(account, t);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {mark}
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The detail sheet's avatar: the sign-in method's mark, 20 px on a 40 px tile one step above the
 * sheet (the IconChip surface), or a person for a method without a mark. Decorative: the meta
 * line names the method.
 */
export function AuthAvatar({
  account,
  className,
}: {
  account: Account;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const key = authKey(account);
  const Logo = AUTH_LOGOS[key];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-2 text-muted-foreground",
        className,
      )}
      data-slot="auth-avatar"
    >
      {key === "apiKey" ? (
        <HugeiconsIcon className="size-5" icon={KeyRoundIcon} />
      ) : Logo ? (
        // The AWS wordmark fills less of its square than a glyph does, so it is drawn larger.
        <Logo className={Logo === AwsLogo ? "size-6.5" : "size-5"} />
      ) : (
        <HugeiconsIcon className="size-5" icon={UserIcon} />
      )}
    </span>
  );
}

/**
 * Email (masked under privacy), sign-in mark and flags, over a muted nickname and plan line with
 * the first two tags after it.
 */
export function AccountIdentity({
  account,
  className,
}: {
  account: Account;
  className?: string;
}): JSX.Element {
  const { t } = useT("accounts");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <AccountName account={account} />
        <AuthIcon account={account} />
        <AccountFlags account={account} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="block min-w-0 truncate text-meta text-muted-foreground leading-tight">
          {accountMeta(account, t, !authIconNamesMethod(account))}
        </span>
        <TagBadges max={2} tags={account.tags} />
      </div>
    </div>
  );
}

/**
 * One usage meter: plan credits, or trial credits for an account with only a trial. The amount
 * leads, the percent sits at the end, and the bar turns orange over 70 % and red over 90 %. The
 * plan label is for screen readers only (the column header names it); a trial says so.
 */
export function UsageMeter({
  account,
  labelled = false,
  className,
}: {
  account: Account;
  /**
   * The detail sheet's meter: the label always shown and the line at 14 px, where no column
   * header names it.
   */
  labelled?: boolean;
  /** Layout only: the meter fills its box (the table column, or a card row). */
  className?: string;
}): JSX.Element {
  const { t, lang } = useT("accounts");
  const hasPlan = account.usageLimit > 0;
  const hasTrial = account.trialUsageLimit > 0;
  if (!hasPlan && !hasTrial) return <span className="text-muted-foreground">{EMPTY}</span>;
  const current = hasPlan ? account.usageCurrent : account.trialUsageCurrent;
  const limit = hasPlan ? account.usageLimit : account.trialUsageLimit;
  const pct = usagePercent(hasPlan ? account.usagePercent : account.trialUsagePercent);
  return (
    <Meter className={cn("w-full min-w-32 gap-1.5", className)} max={100} min={0} value={pct}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-2 leading-none",
          labelled ? "text-sm" : "text-meta",
        )}
      >
        <span className={cn("flex min-w-0 items-baseline", labelled ? "gap-2" : "gap-1.5")}>
          <MeterLabel
            className={cn(
              "shrink-0 font-normal text-muted-foreground",
              labelled ? "text-sm" : "text-meta",
              hasPlan && !labelled && "sr-only",
            )}
          >
            {hasPlan ? t("planCredits") : t("trialCredits")}
          </MeterLabel>
          <span className="truncate tabular-nums">
            {formatCreditAmount(current, lang)} / {formatCreditAmount(limit, lang)}
          </span>
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatFraction(pct / 100, 0)}
        </span>
      </div>
      <MeterTrack>
        <MeterIndicator tone={creditTone(pct)} />
      </MeterTrack>
    </Meter>
  );
}

/** Time left on the access token, muted: the status pill already flags an expired one. */
export function TokenExpiryText({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const expiry = tokenExpiry(account.expiresAt, nowSec());
  return <span className="text-muted-foreground">{formatTokenExpiry(expiry, t)}</span>;
}

/**
 * When the account last served a request: the shared RelativeTime ("5 minutes ago", or "5m ago"
 * narrow), with the full date as a tooltip; a dash when it was never used.
 */
export function LastUsedText({
  account,
  style,
}: {
  account: Account;
  style?: "long" | "narrow";
}): JSX.Element {
  return <RelativeTime style={style} value={account.lastUsed} />;
}

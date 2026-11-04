import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  HourglassIcon,
  type LucideIcon,
  WeightIcon,
  ZapIcon,
} from "lucide-react";
import { type JSX, type ReactNode, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterLabel, MeterTrack } from "@/components/ui/meter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatFraction, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import type { AccountStatus } from "@/routes/-search";
import {
  accountStatus,
  authLabel,
  type CreditTone,
  creditTone,
  formatCreditAmount,
  formatTokenExpiry,
  isHeld,
  overageEnabled,
  planLabel,
  tokenExpiry,
  trialExpiry,
  usagePercent,
} from "./account-model";

/**
 * The one coloured pill of a row. Colour carries the meaning: red stops the account, orange
 * needs attention, grey is the admin's own switch, green is healthy.
 */
export const STATUS_PILL: Record<AccountStatus, { tone: BadgeTone; icon: LucideIcon }> = {
  banned: { tone: "destructive", icon: CircleXIcon },
  suspended: { tone: "warning", icon: CirclePauseIcon },
  noToken: { tone: "destructive", icon: CircleMinusIcon },
  outOfCredits: { tone: "warning", icon: CircleAlertIcon },
  expired: { tone: "warning", icon: ClockIcon },
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
}: {
  account: Account;
  plain?: boolean;
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
      <Badge data-status={status} icon={pill.icon} tone={pill.tone}>
        {label}
      </Badge>
    );
  }
  return (
    <Tooltip>
      {/* Not a tab stop: the reason is also in the detail sheet. */}
      <TooltipTrigger render={<Badge data-status={status} icon={pill.icon} tone={pill.tone} />}>
        {label}
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The email, truncated to its column, with the full (or masked, under privacy) text as a
 * tooltip only when it is cut off.
 */
function TruncatedEmail({ account, className }: { account: Account; className?: string }) {
  const displayEmail = useDisplayEmail();
  const text = displayEmail(account.email, account.id);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      onOpenChange={(next) => {
        const element = ref.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
      open={open}
    >
      <TooltipTrigger
        render={<span className={cn("block min-w-0 truncate font-medium", className)} ref={ref} />}
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup>{text}</TooltipPopup>
    </Tooltip>
  );
}

/** A small muted icon with its meaning as a tooltip and as screen reader text. */
function Flag({ icon: Icon, label }: { icon: LucideIcon; label: string }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" />}>
        <Icon aria-hidden="true" className="size-3.5" />
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
function AccountFlags({ account }: { account: Account }): JSX.Element | null {
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

/** Plan and sign-in method as one muted line ("Team primary · Pro · Builder ID"). */
export function accountMeta(account: Account, t: ReturnType<typeof useT>["t"]): string {
  return [account.nickname, planLabel(account, t), authLabel(account, t)]
    .filter((part) => part && part !== EMPTY)
    .join(" · ");
}

/** Email (masked under privacy) with flags, over a muted nickname, plan and auth line. */
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
        <TruncatedEmail account={account} />
        <AccountFlags account={account} />
      </div>
      <span className="block truncate text-muted-foreground text-xs leading-tight">
        {accountMeta(account, t)}
      </span>
    </div>
  );
}

const TONE_CLASS: Record<CreditTone, string> = {
  default: "bg-primary",
  warning: "bg-(--pill-warning)",
  destructive: "bg-(--pill-error)",
};

/**
 * One usage meter: plan credits, or trial credits for an account with only a trial. The amount
 * leads, the percent sits at the end, and the bar turns orange over 70 % and red over 90 %. The
 * plan label is for screen readers only (the column header names it); a trial says so.
 */
export function UsageMeter({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const hasPlan = account.usageLimit > 0;
  const hasTrial = account.trialUsageLimit > 0;
  if (!hasPlan && !hasTrial) return <span className="text-muted-foreground">{EMPTY}</span>;
  const current = hasPlan ? account.usageCurrent : account.trialUsageCurrent;
  const limit = hasPlan ? account.usageLimit : account.trialUsageLimit;
  const pct = usagePercent(hasPlan ? account.usagePercent : account.trialUsagePercent);
  return (
    <Meter className="w-full min-w-32 max-w-48 gap-1.5" max={100} min={0} value={pct}>
      <div className="flex items-baseline justify-between gap-2 text-xs leading-none">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <MeterLabel
            className={cn(
              "shrink-0 font-normal text-muted-foreground text-xs",
              hasPlan && "sr-only",
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
      <MeterTrack className="h-1 rounded-full">
        <MeterIndicator className={cn("rounded-full", TONE_CLASS[creditTone(pct)])} />
      </MeterTrack>
    </Meter>
  );
}

/** Time left on the access token, muted: the status pill already flags an expired one. */
export function TokenExpiryText({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const expiry = tokenExpiry(account.expiresAt, nowSec());
  return <span className="text-muted-foreground tabular-nums">{formatTokenExpiry(expiry, t)}</span>;
}

/** "5 minutes ago" with the full date as a tooltip; a dash when the account was never used. */
export function LastUsedText({ account }: { account: Account }): JSX.Element {
  const { lang } = useT("accounts");
  if (!account.lastUsed) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            className="whitespace-nowrap tabular-nums"
            dateTime={new Date(account.lastUsed * 1000).toISOString()}
          />
        }
      >
        {formatRelativeTime(account.lastUsed, lang)}
      </TooltipTrigger>
      <TooltipPopup>{formatDateTime(account.lastUsed, lang)}</TooltipPopup>
    </Tooltip>
  );
}

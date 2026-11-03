import type { JSX } from "react";
import { DisplayEmail } from "@/components/shared/display-email";
import { Badge } from "@/components/ui/badge";
import { Meter, MeterIndicator, MeterLabel, MeterTrack } from "@/components/ui/meter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  authLabel,
  type CreditTone,
  creditTone,
  formatCreditAmount,
  formatTokenExpiry,
  healthBadges,
  type SubscriptionTier,
  subscriptionLabel,
  subscriptionTier,
  tokenExpiry,
  trialExpiry,
  usagePercent,
} from "./account-model";

const TIER_VARIANT: Record<SubscriptionTier, "default" | "info" | "secondary" | "outline"> = {
  power: "default",
  proPlus: "info",
  pro: "secondary",
  free: "outline",
};

/** Email (masked under privacy) with the nickname as a muted second line. */
export function AccountIdentity({ account }: { account: Account }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <DisplayEmail className="block max-w-64 font-medium" email={account.email} id={account.id} />
      {account.nickname ? (
        <span className="block max-w-64 truncate text-muted-foreground text-xs">
          {account.nickname}
        </span>
      ) : null}
    </div>
  );
}

/** Subscription, trial, weight, overage and auth badges, in that order. */
export function AccountBadges({
  account,
  className,
}: {
  account: Account;
  className?: string;
}): JSX.Element {
  const { t } = useT("accounts");
  const tier = subscriptionTier(account.subscriptionType);
  const overage = (account.overageStatus ?? "").toUpperCase();
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <Badge variant={tier ? TIER_VARIANT[tier] : "outline"}>
        {subscriptionLabel(account.subscriptionType, t)}
      </Badge>
      {account.trialStatus === "ACTIVE" && account.trialUsageLimit > 0 ? (
        <Badge variant="info">{t("trial")}</Badge>
      ) : null}
      {account.weight >= 2 ? (
        <Badge variant="warning">{t("weightShort", { weight: account.weight })}</Badge>
      ) : null}
      {overage === "ENABLED" || overage === "DISABLED" ? (
        <Tooltip>
          {/* Not a tab stop: the tooltip is a hover hint, and the state is in the sr-only text. */}
          <TooltipTrigger
            render={
              <Badge
                className={cn(overage === "DISABLED" && "text-muted-foreground")}
                variant={overage === "ENABLED" ? "success" : "outline"}
              />
            }
          >
            <span aria-hidden="true">{t("overage")}</span>
            <span className="sr-only">
              {overage === "ENABLED" ? t("overageOn") : t("overageOff")}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{overage === "ENABLED" ? t("overageOn") : t("overageOff")}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Badge variant="outline">{authLabel(account, t)}</Badge>
    </div>
  );
}

/** Health badges: Banned/Suspended, else No token/Expired/Active, plus Out of credits. */
export function HealthBadges({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const badges = healthBadges(account, Math.floor(Date.now() / 1000));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <Badge key={badge.kind} variant={badge.tone}>
          {t(`health.${badge.kind}`)}
        </Badge>
      ))}
    </div>
  );
}

const TONE_CLASS: Record<CreditTone, string> = {
  default: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

function CreditMeter({
  label,
  hideLabel = false,
  hint,
  current,
  limit,
  fraction,
}: {
  label: string;
  /** Keeps the label for screen readers only, when a column header already names it. */
  hideLabel?: boolean;
  hint?: string;
  current: number;
  limit: number;
  fraction: number;
}): JSX.Element {
  const { lang } = useT("accounts");
  const pct = usagePercent(fraction);
  return (
    <Meter className="min-w-36 gap-1" max={100} min={0} value={pct}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <MeterLabel
          className={cn("font-normal text-muted-foreground text-xs", hideLabel && "sr-only")}
        >
          {label}
          {hint ? <span className="ms-1 text-warning-foreground">{hint}</span> : null}
        </MeterLabel>
        <span className="ms-auto text-muted-foreground tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <MeterTrack className="h-1.5 rounded-full">
        <MeterIndicator className={cn("rounded-full", TONE_CLASS[creditTone(pct)])} />
      </MeterTrack>
      <span className="text-xs tabular-nums">
        {formatCreditAmount(current, lang)} / {formatCreditAmount(limit, lang)}
      </span>
    </Meter>
  );
}

/**
 * Plan credits, and trial credits when the account has a trial allowance. `compact` (the table,
 * whose column header already says "Plan credits") hides the plan label unless a trial meter
 * sits under it.
 */
export function CreditMeters({
  account,
  compact = false,
}: {
  account: Account;
  compact?: boolean;
}): JSX.Element | null {
  const { t } = useT("accounts");
  const hasPlan = account.usageLimit > 0;
  const hasTrial = account.trialUsageLimit > 0;
  if (!hasPlan && !hasTrial) return null;
  const expiry = trialExpiry(account.trialExpiresAt, Date.now());
  const expiryLabel =
    expiry?.kind === "expired"
      ? t("trialExpired")
      : expiry?.kind === "today"
        ? t("trialToday")
        : expiry?.kind === "days"
          ? t("trialDays", { days: expiry.days })
          : undefined;
  return (
    <div className="flex min-w-36 flex-col gap-2">
      {hasPlan ? (
        <CreditMeter
          current={account.usageCurrent}
          fraction={account.usagePercent}
          hideLabel={compact && !hasTrial}
          label={t("planCredits")}
          limit={account.usageLimit}
        />
      ) : null}
      {hasTrial ? (
        <CreditMeter
          current={account.trialUsageCurrent}
          fraction={account.trialUsagePercent}
          hint={expiryLabel}
          label={t("trialCredits")}
          limit={account.trialUsageLimit}
        />
      ) : null}
    </div>
  );
}

export function TokenExpiryText({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const expiry = tokenExpiry(account.expiresAt, Math.floor(Date.now() / 1000));
  return (
    <span className={cn("tabular-nums", expiry.kind === "expired" && "text-warning-foreground")}>
      {formatTokenExpiry(expiry, t)}
    </span>
  );
}

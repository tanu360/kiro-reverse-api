// Pure helpers for the Accounts page. Rules keep the old admin panel's behaviour unless noted.

import type { Account, AccountFull, ExportData, ModelInfo } from "@/lib/api/types";
import { dateTimeFormat, EMPTY, numberFormat } from "@/lib/format";
import type { Lang, TFunction } from "@/lib/i18n";
import type { AccountStatusFilter } from "@/routes/-search";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type SubscriptionTier = "power" | "proPlus" | "pro" | "free";

/** Checked in this order: POWER, PRO_PLUS/PROPLUS, PRO, FREE. Empty is Free; unknown is null. */
export function subscriptionTier(type: string): SubscriptionTier | null {
  const upper = (type ?? "").toUpperCase();
  if (upper.includes("POWER")) return "power";
  if (upper.includes("PRO_PLUS") || upper.includes("PROPLUS")) return "proPlus";
  if (upper.includes("PRO")) return "pro";
  if (upper.includes("FREE") || upper === "") return "free";
  return null;
}

/** Plan name; an unknown raw type is shown as-is. */
export function subscriptionLabel(type: string, t: TFunction): string {
  const tier = subscriptionTier(type);
  return tier ? t(`subscription.${tier}`) : type;
}

const AUTH_KEYS: Readonly<Record<string, string>> = {
  idc: "auth.enterprise",
  enterprise: "auth.enterprise",
  external_idp: "auth.microsoft",
  azuread: "auth.microsoft",
  apikey: "auth.apiKey",
  api_key: "auth.apiKey",
  social: "auth.social",
  builderid: "auth.builderId",
  github: "auth.github",
  google: "auth.google",
};

/** Label for `provider || authMethod`. Unknown values are shown raw, empty as a dash. */
export function formatAuthMethod(value: string, t: TFunction): string {
  if (!value) return EMPTY;
  const key = AUTH_KEYS[value.toLowerCase()];
  return key ? t(key) : value;
}

export function authLabel(account: Pick<Account, "provider" | "authMethod">, t: TFunction): string {
  return formatAuthMethod(account.provider || account.authMethod, t);
}

export function isApiKeyAccount(account: Pick<Account, "authMethod">): boolean {
  return account.authMethod.toLowerCase() === "api_key";
}

// ---------------------------------------------------------------------------
// Health and filters
// ---------------------------------------------------------------------------

/** banStatus is set and not ACTIVE. */
export function isBanned(account: Pick<Account, "banStatus">): boolean {
  return Boolean(account.banStatus) && account.banStatus !== "ACTIVE";
}

/** Same rule as the server's exhausted check (pool/account.go). */
export function isOutOfCredits(account: Pick<Account, "usageLimit" | "usageCurrent">): boolean {
  return account.usageLimit > 0 && account.usageCurrent >= account.usageLimit;
}

export type HealthKind = "banned" | "suspended" | "noToken" | "expired" | "active" | "outOfCredits";
export type HealthTone = "error" | "warning" | "success";
export interface HealthBadge {
  kind: HealthKind;
  tone: HealthTone;
}

/** Health badges, separate from the admin enabled switch. */
export function healthBadges(account: Account, nowSec: number): HealthBadge[] {
  const badges: HealthBadge[] = [];
  if (isBanned(account)) {
    if (account.banStatus === "BANNED") badges.push({ kind: "banned", tone: "error" });
    else if (account.banStatus === "SUSPENDED") badges.push({ kind: "suspended", tone: "warning" });
  } else if (!account.hasToken) {
    badges.push({ kind: "noToken", tone: "error" });
  } else if (account.expiresAt && account.expiresAt < nowSec) {
    badges.push({ kind: "expired", tone: "warning" });
  } else {
    badges.push({ kind: "active", tone: "success" });
  }
  if (isOutOfCredits(account)) badges.push({ kind: "outOfCredits", tone: "warning" });
  return badges;
}

function matchesStatus(account: Account, status: AccountStatusFilter): boolean {
  switch (status) {
    case "enabled":
      return account.enabled;
    case "disabled":
      return !account.enabled && !isBanned(account);
    case "banned":
      return isBanned(account);
    default:
      return true;
  }
}

/** Status filter plus a case-insensitive substring search over email or nickname. */
export function filterAccounts(
  accounts: Account[],
  status: AccountStatusFilter | undefined,
  query: string | undefined,
): Account[] {
  const needle = (query ?? "").trim().toLowerCase();
  return accounts.filter(
    (account) =>
      matchesStatus(account, status ?? "all") &&
      (!needle ||
        account.email.toLowerCase().includes(needle) ||
        account.nickname.toLowerCase().includes(needle)),
  );
}

export function statusCounts(accounts: Account[]): Record<AccountStatusFilter, number> {
  const counts: Record<AccountStatusFilter, number> = {
    all: accounts.length,
    enabled: 0,
    disabled: 0,
    banned: 0,
  };
  for (const account of accounts) {
    if (matchesStatus(account, "enabled")) counts.enabled++;
    if (matchesStatus(account, "disabled")) counts.disabled++;
    if (matchesStatus(account, "banned")) counts.banned++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Credits and time
// ---------------------------------------------------------------------------

/** A 0..1 usage fraction as a percent clamped to 0..100. */
export function usagePercent(fraction: number): number {
  const pct = Number(fraction) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** Grouped credits with at most one decimal ("1,488.9", "9,200"), like every other count. */
export function formatCreditAmount(value: number, lang?: Lang): string {
  const n = Number(value);
  return numberFormat(lang, { maximumFractionDigits: 1 }).format(Number.isFinite(n) ? n : 0);
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A reset date as a medium date in the active language. A bare `YYYY-MM-DD` is a calendar day,
 * so it is formatted in UTC and never shifts with the viewer's time zone. Unparsable text is kept.
 */
export function formatResetDate(value: string, lang?: Lang): string {
  const text = (value ?? "").trim();
  if (!text) return EMPTY;
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  const date = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
    : new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return dateTimeFormat(lang, {
    dateStyle: "medium",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  }).format(date);
}

/** Plan name as the list badge shows it; an unknown type falls back to the server's title. */
export function planLabel(
  account: Pick<Account, "subscriptionType" | "subscriptionTitle">,
  t: TFunction,
): string {
  if (subscriptionTier(account.subscriptionType)) {
    return subscriptionLabel(account.subscriptionType, t);
  }
  return account.subscriptionTitle || account.subscriptionType || EMPTY;
}

export type CreditTone = "default" | "warning" | "destructive";

/** Warning over 70 %, destructive over 90 % (old UI bar classes). */
export function creditTone(pct: number): CreditTone {
  if (pct > 90) return "destructive";
  if (pct > 70) return "warning";
  return "default";
}

export type TrialExpiry = { kind: "expired" } | { kind: "today" } | { kind: "days"; days: number };

/** Label for a trial expiry: none for 0 or more than 7 days away. */
export function trialExpiry(trialExpiresAt: number, nowMs: number): TrialExpiry | null {
  if (!trialExpiresAt) return null;
  const days = Math.ceil((trialExpiresAt * 1000 - nowMs) / DAY_MS);
  if (days < 0) return { kind: "expired" };
  if (days === 0) return { kind: "today" };
  if (days <= 7) return { kind: "days", days };
  return null;
}

export type TokenExpiry =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "minutes" | "hours" | "days"; value: number };

/** Time left on the access token, in whole minutes, hours or days. */
export function tokenExpiry(expiresAt: number, nowSec: number): TokenExpiry {
  if (!expiresAt) return { kind: "none" };
  const diff = expiresAt - nowSec;
  if (diff <= 0) return { kind: "expired" };
  if (diff < 3600) return { kind: "minutes", value: Math.floor(diff / 60) };
  if (diff < 86_400) return { kind: "hours", value: Math.floor(diff / 3600) };
  return { kind: "days", value: Math.floor(diff / 86_400) };
}

export function formatTokenExpiry(expiry: TokenExpiry, t: TFunction): string {
  if (expiry.kind === "none") return EMPTY;
  if (expiry.kind === "expired") return t("time.expired");
  return t(`time.${expiry.kind}`, { value: expiry.value });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_PATTERN = /^[0-9a-f]{32}$/i;
const PROXY_PATTERN = /^(socks5|socks5h|http|https):\/\//;

/** Empty (clears the value), a UUID or 32 hex characters, any case. */
export function isValidMachineId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || UUID_PATTERN.test(trimmed) || HEX32_PATTERN.test(trimmed);
}

/** Empty (global proxy) or a socks5, socks5h, http or https URL. */
export function isValidProxyUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || PROXY_PATTERN.test(trimmed);
}

// ---------------------------------------------------------------------------
// Credentials JSON (contains secrets: never log)
// ---------------------------------------------------------------------------

/** The credentials a client needs for one account, by auth type (old copyAccountJSON). */
export function buildCopyJson(account: AccountFull): Record<string, unknown> {
  if (account.authMethod === "api_key") {
    return {
      kiroApiKey: account.kiroApiKey || account.accessToken,
      region: account.region,
      authMethod: "api_key",
    };
  }
  const { clientId, clientSecret, accessToken, refreshToken } = account;
  if (account.authMethod === "external_idp") {
    const { authMethod, provider, userId, profileArn, tokenEndpoint, issuerUrl, scopes } = account;
    return {
      clientId,
      accessToken,
      refreshToken,
      authMethod,
      provider,
      userId,
      profileArn,
      tokenEndpoint,
      issuerUrl,
      scopes,
    };
  }
  return { clientId, clientSecret, accessToken, refreshToken };
}

/** Copy JSON of the export dialog: API keys keep their region, others the client and tokens. */
export function buildExportCopy(data: ExportData): Record<string, unknown>[] {
  return (data.accounts ?? []).map((account) => {
    const { clientId, clientSecret, accessToken, refreshToken, authMethod, region } =
      account.credentials ?? ({} as ExportData["accounts"][number]["credentials"]);
    if (authMethod === "api_key") return { kiroApiKey: accessToken, region, authMethod };
    return { clientId, clientSecret, accessToken, refreshToken };
  });
}

/** kiro-accounts-YYYY-MM-DD.json in local time. */
export function exportFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `kiro-accounts-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function modelRate(model: Pick<ModelInfo, "rateMultiplier">): number {
  return model.rateMultiplier || 1;
}

/** `auto` first, then by credit multiplier ascending (a missing multiplier counts as 1). */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    if (a.modelId === "auto") return -1;
    if (b.modelId === "auto") return 1;
    return modelRate(a) - modelRate(b);
  });
}

/** Overage switch state from the snapshot fields. */
export function overageEnabled(account: Pick<Account, "overageStatus">): boolean {
  return (account.overageStatus ?? "").toUpperCase() === "ENABLED";
}

export function overageCapable(account: Pick<Account, "overageCapability">): boolean {
  return (account.overageCapability ?? "").toUpperCase() !== "NOT_OVERAGE_CAPABLE";
}

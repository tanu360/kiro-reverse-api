// Pure helpers for the Accounts page. Rules keep the old admin panel's behaviour unless noted.

import { serverCodeMessage } from "@/lib/api/server-errors";
import type {
  Account,
  AccountActionResult,
  AccountFull,
  ExportData,
  ModelInfo,
} from "@/lib/api/types";
import { belowStep, dateTimeFormat, EMPTY, numberFormat, roundsToZero } from "@/lib/format";
import { joinList, type Lang, type TFunction } from "@/lib/i18n";
import {
  ACCOUNT_STATUSES,
  type AccountSort,
  type AccountStatus,
  type AccountStatusFilter,
  type AccountsSearch,
} from "@/routes/-search";
import { hasTag, tagKey } from "./account-metadata";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type SubscriptionTier = "power" | "proPlus" | "pro" | "free";

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

/**
 * The banStatus the server writes when an account is switched off, by the admin or by the pool
 * (config.SetAccountEnabled, pool DisableAccount). It reads as Disabled, not as a ban.
 */
const DISABLED_BAN_STATUS = "DISABLED";

/** banStatus is set and not ACTIVE: the server holds the account back (config.go). */
export function isHeld(account: Pick<Account, "banStatus">): boolean {
  return Boolean(account.banStatus) && account.banStatus !== "ACTIVE";
}

/** Banned or suspended upstream: held back for any reason but the admin's own DISABLED. */
export function isBanned(account: Pick<Account, "banStatus">): boolean {
  return isHeld(account) && account.banStatus !== DISABLED_BAN_STATUS;
}

/** Same rule as the server's exhausted check (pool/account.go). */
function isOutOfCredits(account: Pick<Account, "usageLimit" | "usageCurrent">): boolean {
  return account.usageLimit > 0 && account.usageCurrent >= account.usageLimit;
}

/**
 * The one status a row shows: the worst state of the account, in the order of ACCOUNT_STATUSES
 * (banned, suspended, no token, out of credits, expired token, disabled by the admin, active).
 * An unknown ban status that is not ACTIVE counts as banned; DISABLED is the admin's switch.
 */
export function accountStatus(account: Account, nowSec: number): AccountStatus {
  if (isBanned(account)) return account.banStatus === "SUSPENDED" ? "suspended" : "banned";
  if (!account.hasToken) return "noToken";
  if (isOutOfCredits(account)) return "outOfCredits";
  if (account.expiresAt && account.expiresAt < nowSec) return "expired";
  if (!account.enabled || account.banStatus === DISABLED_BAN_STATUS) return "disabled";
  return "active";
}

/** 0 for the worst status, rising to `active`. */
function statusRank(status: AccountStatus): number {
  return ACCOUNT_STATUSES.indexOf(status);
}

/** The status tabs past All: working, needs a look, switched off by the admin. */
export type StatusGroup = "active" | "attention" | "disabled";
export const STATUS_GROUPS: readonly StatusGroup[] = ["active", "attention", "disabled"];

/** Banned, suspended, no token, out of credits and token expired all need a look. */
export function statusGroup(status: AccountStatus): StatusGroup {
  return status === "active" || status === "disabled" ? status : "attention";
}

/** The tab a `status` filter belongs to; undefined is All. */
export function statusFilterGroup(
  filter: AccountStatusFilter | undefined,
): StatusGroup | undefined {
  if (!filter) return undefined;
  return filter === "attention" ? "attention" : statusGroup(filter);
}

/** Whether a row status passes the `status` filter; `attention` takes the whole group. */
function matchesStatus(status: AccountStatus, filter: AccountStatusFilter): boolean {
  return filter === "attention" ? statusGroup(status) === "attention" : status === filter;
}

/** Canonical auth method ids: one per label, so a filter never lists Enterprise twice. */
const AUTH_IDS: Readonly<Record<string, string>> = {
  idc: "enterprise",
  enterprise: "enterprise",
  external_idp: "microsoft",
  azuread: "microsoft",
  microsoft: "microsoft",
  apikey: "apiKey",
  api_key: "apiKey",
  social: "social",
  builderid: "builderId",
  github: "github",
  google: "google",
};

/** `provider || authMethod` as a canonical id; an unknown value is kept, lowercased. */
export function authKey(account: Pick<Account, "provider" | "authMethod">): string {
  const raw = (account.provider || account.authMethod || "").toLowerCase();
  return AUTH_IDS[raw] ?? raw;
}

/**
 * Login types Kiro lists no profiles for: ListAvailableProfiles answers 403 for Builder ID and
 * an empty list for social logins, and api_key accounts have no profile at all.
 */
const NO_PROFILE_AUTH: ReadonlySet<string> = new Set([
  "builderId",
  "social",
  "github",
  "google",
  "apiKey",
]);

/**
 * Whether Kiro can list profiles for this account: Enterprise (IAM Identity Center) and
 * Microsoft SSO logins. An unknown login type stays allowed, so the server decides.
 */
export function supportsKiroProfiles(account: Pick<Account, "provider" | "authMethod">): boolean {
  return !NO_PROFILE_AUTH.has(authKey(account));
}

/** A plan tier, or the raw subscription type when the tier is unknown. */
function planKey(account: Pick<Account, "subscriptionType">): string {
  return subscriptionTier(account.subscriptionType) ?? account.subscriptionType;
}

/** The OAuth region; an empty one is us-east-1, as the detail sheet shows it. */
function regionKey(account: Pick<Account, "region">): string {
  return account.region || "us-east-1";
}

export type FilterDimension = "status" | "plan" | "auth" | "region" | "enabled" | "tag";
export const FILTER_DIMENSIONS: readonly FilterDimension[] = [
  "status",
  "plan",
  "auth",
  "region",
  "enabled",
  "tag",
];
export type AccountFilters = Pick<AccountsSearch, "q" | FilterDimension>;

/** The dimensions with one value per account; an account has any number of tags. */
type SingleValueDimension = Exclude<FilterDimension, "tag">;

function dimensionValue(account: Account, dimension: SingleValueDimension, nowSec: number): string {
  switch (dimension) {
    case "status":
      return accountStatus(account, nowSec);
    case "plan":
      return planKey(account);
    case "auth":
      return authKey(account);
    case "region":
      return regionKey(account);
    case "enabled":
      return account.enabled ? "on" : "off";
  }
}

function matchesDimension(
  account: Account,
  dimension: FilterDimension,
  filter: string,
  nowSec: number,
): boolean {
  if (dimension === "tag") return hasTag(account, filter);
  const value = dimensionValue(account, dimension, nowSec);
  return dimension === "status"
    ? matchesStatus(value as AccountStatus, filter as AccountStatusFilter)
    : value === filter;
}

/** The query against the email, nickname, notes and every tag, ignoring case. */
function matchesQuery(account: Account, needle: string): boolean {
  return (
    account.email.toLowerCase().includes(needle) ||
    account.nickname.toLowerCase().includes(needle) ||
    (account.notes ?? "").toLowerCase().includes(needle) ||
    (account.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  );
}

/**
 * Every set filter must match; the query is a case-insensitive substring of the email, nickname,
 * notes or a tag. A status filter of `attention` matches any problem status, and a tag filter
 * matches the tag in any case.
 */
export function filterAccounts(
  accounts: Account[],
  filters: AccountFilters,
  nowSec: number,
): Account[] {
  const needle = (filters.q ?? "").trim().toLowerCase();
  const active = FILTER_DIMENSIONS.filter((dimension) => filters[dimension] !== undefined);
  return accounts.filter(
    (account) =>
      active.every((dimension) =>
        matchesDimension(account, dimension, filters[dimension] as string, nowSec),
      ) &&
      (!needle || matchesQuery(account, needle)),
  );
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Every tag across the list, with how many accounts have it. Spellings that differ only in case
 * are one tag: the value is the lowercase key and the label the first spelling met.
 */
function tagOptions(accounts: Account[]): FilterOption[] {
  const options = new Map<string, FilterOption>();
  for (const account of accounts) {
    const counted = new Set<string>();
    for (const tag of account.tags ?? []) {
      const key = tagKey(tag);
      if (counted.has(key)) continue;
      counted.add(key);
      const option = options.get(key);
      if (option) option.count++;
      else options.set(key, { value: key, label: tag, count: 1 });
    }
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The values of one dimension across the whole list, with how many accounts have each. Statuses
 * keep their worst-first order and enabled is On, Off; the rest are sorted by label.
 */
export function filterOptions(
  accounts: Account[],
  dimension: FilterDimension,
  t: TFunction,
  nowSec: number,
): FilterOption[] {
  if (dimension === "tag") return tagOptions(accounts);
  const options = new Map<string, FilterOption>();
  for (const account of accounts) {
    const value = dimensionValue(account, dimension, nowSec);
    const option = options.get(value);
    if (option) {
      option.count++;
      continue;
    }
    options.set(value, { value, label: optionLabel(account, dimension, value, t), count: 1 });
  }
  const list = [...options.values()];
  if (dimension === "status") {
    return list.sort(
      (a, b) => statusRank(a.value as AccountStatus) - statusRank(b.value as AccountStatus),
    );
  }
  if (dimension === "enabled")
    return list.sort((a, b) => (a.value === "on" ? -1 : b.value === "on" ? 1 : 0));
  return list.sort((a, b) => a.label.localeCompare(b.label));
}

function optionLabel(
  account: Account,
  dimension: SingleValueDimension,
  value: string,
  t: TFunction,
): string {
  switch (dimension) {
    case "status":
      return t(`health.${value}`);
    case "plan":
      return planLabel(account, t);
    case "auth":
      return authLabel(account, t);
    case "region":
      return value;
    case "enabled":
      return value === "on" ? t("filter.enabledOn") : t("filter.enabledOff");
  }
}

/** The usage fraction a row shows: plan credits, else trial credits; -1 without either. */
function usageFraction(account: Account): number {
  if (account.usageLimit > 0) return Number(account.usagePercent) || 0;
  if (account.trialUsageLimit > 0) return Number(account.trialUsagePercent) || 0;
  return -1;
}

/** The order a column sorts in on its first click: big numbers and recent use first. */
export function defaultSortDesc(column: string): boolean {
  return column === "usage" || column === "requests" || column === "lastUsed";
}

/**
 * Sorted copy of the list. Missing values (no usage limit, never used, no token expiry) stay at
 * the end in both directions, and ties keep the server order.
 */
export function sortAccounts(
  accounts: Account[],
  sort: AccountSort | undefined,
  desc: boolean,
  nowSec: number,
): Account[] {
  if (!sort) return accounts;
  const key = (account: Account): number | string | null => {
    switch (sort) {
      case "account":
        return (account.email || account.id).toLowerCase();
      case "status":
        return statusRank(accountStatus(account, nowSec));
      case "usage": {
        const fraction = usageFraction(account);
        return fraction < 0 ? null : fraction;
      }
      case "requests":
        return account.requestCount;
      case "lastUsed":
        return account.lastUsed || null;
      case "expiry":
        return account.expiresAt || null;
    }
  };
  const keyed = accounts.map((account, index) => ({ account, index, key: key(account) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      if (a.key === b.key) return a.index - b.index;
      return a.key === null ? 1 : -1;
    }
    const order =
      typeof a.key === "string" && typeof b.key === "string"
        ? a.key.localeCompare(b.key)
        : (a.key as number) - (b.key as number);
    return (desc ? -order : order) || a.index - b.index;
  });
  return keyed.map((entry) => entry.account);
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

/**
 * Grouped credits with at most one decimal ("1,488.9", "9,200"), like every other count. A tiny
 * non-zero amount reads "<0.1", never "0".
 */
export function formatCreditAmount(value: number, lang?: Lang): string {
  const n = Number(value);
  if (roundsToZero(n, 1)) return belowStep(1, lang);
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

/** A reset date as unix seconds (a bare `YYYY-MM-DD` is midnight UTC); null when it is unparsable. */
export function resetDateSec(value: string): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  const ms = dateOnly
    ? Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(text).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
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

type CreditTone = "default" | "warning" | "destructive";

/** Warning over 70 %, destructive over 90 % (old UI bar classes). */
export function creditTone(pct: number): CreditTone {
  if (pct > 90) return "destructive";
  if (pct > 70) return "warning";
  return "default";
}

type TrialExpiry = { kind: "expired" } | { kind: "today" } | { kind: "days"; days: number };

/** Label for a trial expiry: none for 0 or more than 7 days away. */
export function trialExpiry(trialExpiresAt: number, nowMs: number): TrialExpiry | null {
  if (!trialExpiresAt) return null;
  const days = Math.ceil((trialExpiresAt * 1000 - nowMs) / DAY_MS);
  if (days < 0) return { kind: "expired" };
  if (days === 0) return { kind: "today" };
  if (days <= 7) return { kind: "days", days };
  return null;
}

type TokenExpiry =
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
const PROXY_PATTERN = /^(socks5|socks5h|http|https):\/\/([^/?#]*)\/?$/i;

/** Empty (clears the value), a UUID or 32 hex characters, any case. */
export function isValidMachineId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || UUID_PATTERN.test(trimmed) || HEX32_PATTERN.test(trimmed);
}

/**
 * A proxy URL to show on screen: the password goes, the user name stays
 * (`socks5://user:secret@host:1080` reads `socks5://user@host:1080`).
 */
export function proxyDisplayUrl(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)([^:@/]*):[^@/]*@/i, "$1$2@");
}

/** What the server shows in place of a saved proxy password; sent back, it keeps the password. */
export const MASKED_PROXY_PASSWORD = "********";

/** Whether a proxy URL from the server holds a saved password (shown masked). */
export function hasMaskedProxyPassword(url: string): boolean {
  return url.includes(`:${MASKED_PROXY_PASSWORD}@`);
}

/**
 * Empty (global proxy) or a socks5, socks5h, http or https URL with a host, and a port from 1 to
 * 65535 (http and https may leave it out). The same rules as the server's ValidateOutboundURL:
 * "http://", port 99999, a space or a host with a second port are refused.
 */
export function isValidProxyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  const match = PROXY_PATTERN.exec(trimmed);
  if (!match || /\s/.test(trimmed)) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  const authority = match[2] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  let host = hostPort;
  let port = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return false;
    host = hostPort.slice(1, close);
    // Brackets hold an IPv6 address, never a typed host:port.
    // An IPv6 address has at least two colons; "1.2.3.4:8080" in brackets is a host:port.
    if (!/^[0-9a-f:.]+(%.+)?$/i.test(host) || host.split(":").length < 3) return false;
    const rest = hostPort.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return false;
    port = rest.slice(1);
  } else {
    const parts = hostPort.split(":");
    if (parts.length > 2) return false;
    host = parts[0] ?? "";
    port = parts[1] ?? "";
  }
  if (host === "") return false;
  if (port === "") return !scheme.startsWith("socks5");
  const n = Number(port);
  return /^\d+$/.test(port) && n >= 1 && n <= 65535;
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

// ---------------------------------------------------------------------------
// Batch results
// ---------------------------------------------------------------------------

/** How many failed accounts a result toast names before it says "and N more". */
const FAILURE_NAMES_SHOWN = 3;

/**
 * The failed rows of a batch or sweep answer as one toast description. Rows that share an error
 * show it once ("name and 4 more: error"), so a sweep where every account hit the same upstream
 * error reads as one line. The first few reasons are listed, then "and N more" counts the
 * accounts left out. `nameOf` gives the display name (masked under privacy); an id with no
 * account falls back to the id. Empty when nothing failed.
 */
export function describeFailures(
  results: readonly AccountActionResult[] | undefined,
  nameOf: (id: string) => string,
  t: TFunction,
): string {
  const groups = new Map<string, { reason: string; ids: string[] }>();
  for (const result of results ?? []) {
    if (result.ok) continue;
    // The row's code picks the text; `error`, the server's English, is left for an unknown code.
    const reason =
      serverCodeMessage(result.code, result, t) ??
      (result.status === "not_found" ? t("batch.notFound") : result.error || "");
    //! A row with no reason has nothing to share, so it keeps a line of its own.
    const key = reason ? `reason:${reason}` : `id:${result.id}`;
    const group = groups.get(key);
    if (group) group.ids.push(result.id);
    else groups.set(key, { reason, ids: [result.id] });
  }
  if (groups.size === 0) return "";
  const entries = [...groups.values()];
  const lines = entries.slice(0, FAILURE_NAMES_SHOWN).map(({ reason, ids }) => {
    const name = nameOf(ids[0]);
    if (ids.length > 1) return t("batch.failureShared", { name, count: ids.length - 1, reason });
    return reason ? t("batch.failureItem", { name, reason }) : name;
  });
  const rest = entries
    .slice(FAILURE_NAMES_SHOWN)
    .reduce((total, group) => total + group.ids.length, 0);
  if (rest > 0) lines.push(t("batch.moreFailures", { count: rest }));
  // One line: a toast description does not keep line breaks.
  return joinList(t, lines);
}

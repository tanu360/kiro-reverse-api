// Search-param schemas for the file routes. The "-" prefix keeps this file out of the route
// tree. Features import the types from here; this module must not import route files.

export type OverviewRange = "1h" | "6h" | "24h";
/** range undefined = '1h' */
interface OverviewSearch {
  range?: OverviewRange;
}

/**
 * The one status an account row shows, worst first (account-model.ts accountStatus). The list
 * filters on the same value, so a filter always matches the pill a row shows.
 */
export const ACCOUNT_STATUSES = [
  "banned",
  "suspended",
  "noToken",
  "outOfCredits",
  "expired",
  "disabled",
  "active",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * The `status` filter: one row status, or `attention` for every status that needs a look
 * (banned, suspended, no token, out of credits, token expired). The status tabs set active,
 * attention or disabled; a single problem status (an old link, or the Issue select) still works.
 */
export const ACCOUNT_STATUS_FILTERS = [...ACCOUNT_STATUSES, "attention"] as const;
export type AccountStatusFilter = (typeof ACCOUNT_STATUS_FILTERS)[number];

/** Sortable Accounts columns; the ids match the table's column ids. */
export const ACCOUNT_SORTS = [
  "account",
  "status",
  "usage",
  "requests",
  "lastUsed",
  "expiry",
] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];

export interface AccountsSearch {
  add?: true;
  q?: string;
  status?: AccountStatusFilter;
  /** A plan tier (power, proPlus, pro, free) or an unknown raw subscription type. */
  plan?: string;
  /** A canonical auth method (account-model.ts authKey). */
  auth?: string;
  region?: string;
  enabled?: "on" | "off";
  sort?: AccountSort;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: 10 | 25 | 50 | 100;
}

/** Matches research RequestSort and the Requests table column ids. */
export const REQUEST_SORTS = [
  "time",
  "status",
  "account",
  "api_key",
  "model",
  "tokens",
  "credits",
  "duration",
] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];

export interface RequestsSearch {
  page?: number;
  pageSize?: 10 | 25 | 50 | 100;
  search?: string;
  status?: "success" | "failed";
  sort?: RequestSort;
  order?: "asc" | "desc";
}

interface LoginSearch {
  redirect?: string;
}

const OVERVIEW_RANGES: readonly OverviewRange[] = ["1h", "6h", "24h"];
const PAGE_SIZES: readonly NonNullable<RequestsSearch["pageSize"]>[] = [10, 25, 50, 100];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Non-empty text; numbers are accepted because the default search parser JSON-decodes them. */
function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

// Every validator returns each key it owns, set to undefined when the raw value is invalid.
// TanStack Router merges a route's validated search over its parent's search, and the root's
// parent is the raw URL search. A key left out keeps its raw value (?range=7d), and the page
// then reads a value that was never validated.

export function validateOverviewSearch(input: Record<string, unknown>): OverviewSearch {
  return { range: oneOf(input.range, OVERVIEW_RANGES) };
}

function pageNumber(value: unknown): number | undefined {
  const n = integer(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

function pageSize(value: unknown): RequestsSearch["pageSize"] {
  const n = integer(value);
  return n !== undefined && (PAGE_SIZES as readonly number[]).includes(n)
    ? (n as RequestsSearch["pageSize"])
    : undefined;
}

export function validateAccountsSearch(input: Record<string, unknown>): AccountsSearch {
  const add = input.add === true || input.add === 1 || input.add === "1" || input.add === "true";
  // `status=enabled` was the old status segment; it is the Enabled filter now.
  const legacyEnabled = input.status === "enabled" ? "on" : undefined;
  return {
    add: add ? true : undefined,
    q: text(input.q),
    status: oneOf(input.status, ACCOUNT_STATUS_FILTERS),
    plan: text(input.plan),
    auth: text(input.auth),
    region: text(input.region),
    enabled: oneOf(input.enabled, ["on", "off"] as const) ?? legacyEnabled,
    sort: oneOf(input.sort, ACCOUNT_SORTS),
    order: oneOf(input.order, ["asc", "desc"] as const),
    page: pageNumber(input.page),
    pageSize: pageSize(input.pageSize),
  };
}

export function validateRequestsSearch(input: Record<string, unknown>): RequestsSearch {
  return {
    page: pageNumber(input.page),
    pageSize: pageSize(input.pageSize),
    search: text(input.search),
    status: oneOf(input.status, ["success", "failed"] as const),
    sort: oneOf(input.sort, REQUEST_SORTS),
    order: oneOf(input.order, ["asc", "desc"] as const),
  };
}

/** Same-origin app paths only: "/x" but never "//host" or "/\host" (open-redirect guard). */
function isSafeRedirect(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
  );
}

export function validateLoginSearch(input: Record<string, unknown>): LoginSearch {
  return { redirect: isSafeRedirect(input.redirect) ? input.redirect : undefined };
}

/**
 * Splits a `redirect` value such as "/requests?page=2" into a router target, because
 * navigate({ to }) and redirect({ to }) do not accept a query string. Undefined or unsafe
 * values go to Overview.
 */
export function redirectTarget(redirect: string | undefined): {
  to: string;
  search: Record<string, string>;
} {
  if (!isSafeRedirect(redirect)) return { to: "/", search: {} };
  const withoutHash = redirect.split("#")[0] ?? "/";
  const queryStart = withoutHash.indexOf("?");
  const to = queryStart === -1 ? withoutHash : withoutHash.slice(0, queryStart);
  const search: Record<string, string> = {};
  if (queryStart !== -1) {
    for (const [key, value] of new URLSearchParams(withoutHash.slice(queryStart + 1))) {
      search[key] = value;
    }
  }
  return { to: to || "/", search };
}

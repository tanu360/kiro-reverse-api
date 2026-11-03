// Search-param schemas for the file routes. The "-" prefix keeps this file out of the route
// tree. Features import the types from here; this module must not import route files.

export type OverviewRange = "1h" | "6h" | "24h";
/** range undefined = '1h' */
export interface OverviewSearch {
  range?: OverviewRange;
}

export type AccountStatusFilter = "all" | "enabled" | "disabled" | "banned";
export interface AccountsSearch {
  add?: true;
  status?: Exclude<AccountStatusFilter, "all">;
  q?: string;
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
  pageSize?: 25 | 50 | 100;
  search?: string;
  status?: "success" | "failed";
  sort?: RequestSort;
  order?: "asc" | "desc";
}

export interface LoginSearch {
  redirect?: string;
}

const OVERVIEW_RANGES: readonly OverviewRange[] = ["1h", "6h", "24h"];
const ACCOUNT_STATUSES: readonly Exclude<AccountStatusFilter, "all">[] = [
  "enabled",
  "disabled",
  "banned",
];
const PAGE_SIZES: readonly NonNullable<RequestsSearch["pageSize"]>[] = [25, 50, 100];

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

export function validateOverviewSearch(input: Record<string, unknown>): OverviewSearch {
  const range = oneOf(input.range, OVERVIEW_RANGES);
  return range ? { range } : {};
}

export function validateAccountsSearch(input: Record<string, unknown>): AccountsSearch {
  const out: AccountsSearch = {};
  if (input.add === true || input.add === 1 || input.add === "1" || input.add === "true") {
    out.add = true;
  }
  const status = oneOf(input.status, ACCOUNT_STATUSES);
  if (status) out.status = status;
  const q = text(input.q);
  if (q !== undefined) out.q = q;
  return out;
}

export function validateRequestsSearch(input: Record<string, unknown>): RequestsSearch {
  const out: RequestsSearch = {};
  const page = integer(input.page);
  if (page !== undefined && page >= 1) out.page = page;
  const pageSize = integer(input.pageSize);
  if (pageSize !== undefined && (PAGE_SIZES as readonly number[]).includes(pageSize)) {
    out.pageSize = pageSize as RequestsSearch["pageSize"];
  }
  const search = text(input.search);
  if (search !== undefined) out.search = search;
  const status = oneOf(input.status, ["success", "failed"] as const);
  if (status) out.status = status;
  const sort = oneOf(input.sort, REQUEST_SORTS);
  if (sort) out.sort = sort;
  const order = oneOf(input.order, ["asc", "desc"] as const);
  if (order) out.order = order;
  return out;
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
  return isSafeRedirect(input.redirect) ? { redirect: input.redirect } : {};
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

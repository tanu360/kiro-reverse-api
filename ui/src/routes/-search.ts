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

// Every validator returns each key it owns, set to undefined when the raw value is invalid.
// TanStack Router merges a route's validated search over its parent's search, and the root's
// parent is the raw URL search. A key left out keeps its raw value (?range=7d), and the page
// then reads a value that was never validated.

export function validateOverviewSearch(input: Record<string, unknown>): OverviewSearch {
  return { range: oneOf(input.range, OVERVIEW_RANGES) };
}

export function validateAccountsSearch(input: Record<string, unknown>): AccountsSearch {
  const add = input.add === true || input.add === 1 || input.add === "1" || input.add === "true";
  return {
    add: add ? true : undefined,
    status: oneOf(input.status, ACCOUNT_STATUSES),
    q: text(input.q),
  };
}

export function validateRequestsSearch(input: Record<string, unknown>): RequestsSearch {
  const page = integer(input.page);
  const pageSize = integer(input.pageSize);
  return {
    page: page !== undefined && page >= 1 ? page : undefined,
    pageSize:
      pageSize !== undefined && (PAGE_SIZES as readonly number[]).includes(pageSize)
        ? (pageSize as RequestsSearch["pageSize"])
        : undefined,
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

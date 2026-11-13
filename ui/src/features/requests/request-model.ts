// Pure helpers for the Requests page: URL state to API params, row keys, masking, badge tones.
import type {
  RecentRequestsParams,
  RequestEndpoint,
  RequestErrorType,
  RequestRecord,
} from "@/lib/api/types";
import { dateTimeFormat, unixToDate } from "@/lib/format";
import { type Lang, translate } from "@/lib/i18n";
import type { RequestSort, RequestsSearch } from "@/routes/-search";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const DEFAULT_SORT: RequestSort = "time";
export const DEFAULT_ORDER = "desc" as const;
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

const ERROR_TYPES: readonly RequestErrorType[] = [
  "client_closed",
  "api_key_limit",
  "overage",
  "quota",
  "suspended",
  "profile",
  "proxy",
  "auth",
  "stream",
  "no_accounts",
  "invalid_request",
  "rate_limit",
  "timeout",
  "upstream",
  "unknown",
];

const ENDPOINTS: readonly RequestEndpoint[] = ["claude", "openai", "responses"];

export type ErrorTone = "muted" | "warning" | "destructive";

const MUTED_TYPES: ReadonlySet<string> = new Set([
  "client_closed",
  "invalid_request",
  "api_key_limit",
]);
const WARNING_TYPES: ReadonlySet<string> = new Set([
  "proxy",
  "stream",
  "timeout",
  "rate_limit",
  "upstream",
  "unknown",
]);

/** Three tiers, as in the old UI: anything not muted or warning (unmapped too) is destructive. */
export function errorTypeTone(type: string | undefined): ErrorTone {
  if (type && MUTED_TYPES.has(type)) return "muted";
  if (type && WARNING_TYPES.has(type)) return "warning";
  return "destructive";
}

export function isKnownErrorType(type: string | undefined): type is RequestErrorType {
  return type !== undefined && (ERROR_TYPES as readonly string[]).includes(type);
}

export function isKnownEndpoint(endpoint: string | undefined): endpoint is RequestEndpoint {
  return endpoint !== undefined && (ENDPOINTS as readonly string[]).includes(endpoint);
}

/**
 * The server sends `first6****last4`; a value without `****` that is longer than 10 characters
 * is masked the same way here, so a raw key never shows. Shorter keys stay in full (server rule).
 */
export function normalizeApiKeyMask(value: string | undefined): string {
  if (!value) return "";
  if (value.includes("****") || value.length <= 10) return value;
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

/** In-memory rows (persistent: false) have no id, so they fall back to ts plus position. */
export function rowKey(record: RequestRecord, index: number): string {
  return record.id === undefined ? `${record.ts}-${index}` : String(record.id);
}

/** URL search to API params: defaults applied, empty search and status left out. */
export function toQueryParams(search: RequestsSearch, lang?: Lang): RecentRequestsParams {
  const params: RecentRequestsParams = {
    page: search.page ?? DEFAULT_PAGE,
    pageSize: search.pageSize ?? DEFAULT_PAGE_SIZE,
    sort: search.sort ?? DEFAULT_SORT,
    order: search.order ?? DEFAULT_ORDER,
  };
  const text = search.search?.trim();
  const errorType = text && lang ? errorTypeForSearch(text, lang) : undefined;
  if (errorType) params.errorType = errorType;
  else if (text) params.search = text;
  if (search.status) params.status = search.status;
  return params;
}

/**
 * The error type a search names by the label the table shows ("Proxy error"), in the page's
 * language or in English. The server matches that type exactly; the raw name ("proxy") stays a
 * plain search, which also finds it in messages.
 */
export function errorTypeForSearch(text: string, lang: Lang): RequestErrorType | undefined {
  const value = text.trim().toLocaleLowerCase();
  if (!value) return undefined;
  for (const type of ERROR_TYPES) {
    const key = `errorType.${type}`;
    for (const label of [translate(lang, "requests", key), translate("en", "requests", key)]) {
      if (label && label !== key && label.toLocaleLowerCase() === value) return type;
    }
  }
  return undefined;
}

/** Drops default values so the URL only carries what the viewer changed. */
export function cleanSearch(search: RequestsSearch): RequestsSearch {
  const out: RequestsSearch = {};
  if (search.page !== undefined && search.page !== DEFAULT_PAGE) out.page = search.page;
  if (search.pageSize !== undefined && search.pageSize !== DEFAULT_PAGE_SIZE) {
    out.pageSize = search.pageSize;
  }
  const text = search.search?.trim();
  if (text) out.search = text;
  if (search.status) out.status = search.status;
  const sort = search.sort ?? DEFAULT_SORT;
  const order = search.order ?? DEFAULT_ORDER;
  if (sort !== DEFAULT_SORT || order !== DEFAULT_ORDER) {
    out.sort = sort;
    out.order = order;
  }
  return out;
}

/** A newly sorted column starts descending for time and ascending for everything else. */
export function defaultSortDesc(columnId: string): boolean {
  return columnId === "time";
}

/**
 * Search text that may be a client API key: one word with a key prefix, or 20 characters or
 * more with no spaces. It stays out of the page URL, so a pasted key never lands in the
 * address bar or the browser history. Masked keys (with *) are not secrets.
 */
export function isSecretSearch(text: string): boolean {
  const value = text.trim();
  if (value === "" || /[\s*]/.test(value)) return false;
  return /^(sk|ksk|key)[-_]/i.test(value) || value.length >= 20;
}

export function hasFilters(search: RequestsSearch): boolean {
  return Boolean(search.search?.trim() || search.status);
}

function dateFormat(lang: Lang, withYear: boolean): Intl.DateTimeFormat {
  return dateTimeFormat(
    lang,
    withYear ? { dateStyle: "medium" } : { month: "short", day: "numeric" },
  );
}

/** Date line of the Time column: "Nov 3" this year, "Nov 3, 2025" for older rows. */
export function formatRowDate(unixSec: number, lang: Lang, now: Date = new Date()): string {
  const date = unixToDate(unixSec);
  return dateFormat(lang, date.getFullYear() !== now.getFullYear()).format(date);
}

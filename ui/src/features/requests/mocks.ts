import { type HttpHandler, HttpResponse, http } from "msw";
import type { RecentRequestsResponse, RequestRecord, RequestSort } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, mockDelay, requireAuth } from "@/lib/mocks/http";

const SORTS: readonly RequestSort[] = [
  "time",
  "status",
  "account",
  "api_key",
  "model",
  "tokens",
  "credits",
  "duration",
];
const MEMORY_RING_SIZE = 200;

interface NormalizedQuery {
  page: number;
  pageSize: number;
  search: string;
  status: "" | "success" | "failed";
  sort: RequestSort;
  order: "asc" | "desc";
}

/** Go's strconv.Atoi plus "> 0": anything else counts as missing. */
function positiveInt(value: string | null): number | undefined {
  if (value === null || !/^[+-]?\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n > 0 ? n : undefined;
}

/** apiObserveRecentRequests + normalizeRequestQuery (proxy/observe.go). */
function normalizeQuery(url: URL): NormalizedQuery {
  const q = url.searchParams;
  const page = positiveInt(q.get("page")) ?? 1;
  const pageSize = Math.min(
    200,
    positiveInt(q.get("pageSize")) ?? positiveInt(q.get("limit")) ?? 25,
  );
  const status = (q.get("status") ?? "").trim().toLowerCase();
  const sort = (q.get("sort") ?? "").trim().toLowerCase();
  const order = (q.get("order") ?? "").trim().toLowerCase();
  return {
    page,
    pageSize,
    search: (q.get("search") ?? "").trim(),
    status: status === "success" || status === "failed" ? status : "",
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as RequestSort) : "time",
    order: order === "asc" ? "asc" : "desc",
  };
}

// id -> raw key, rebuilt once per request: a linear lookup per row and comparison is too slow for
// the full dataset's ~12k rows.
let keyIndex = new Map<string, string>();

function indexKeys(): void {
  keyIndex = new Map(mockDb.apiKeys.map((key) => [key.id, key.key]));
}

/** The raw key behind a row: the server searches and sorts by it but never sends it. */
function rawKey(record: RequestRecord): string {
  if (!record.apiKeyId) return "";
  return keyIndex.get(record.apiKeyId) ?? "";
}

function matches(record: RequestRecord, query: NormalizedQuery): boolean {
  if (query.status === "success" && !record.success) return false;
  if (query.status === "failed" && record.success) return false;
  if (!query.search) return true;
  const needle = query.search.toLowerCase();
  return [
    record.email,
    record.accountId,
    record.apiKeyId,
    rawKey(record),
    record.model,
    record.message,
    record.endpoint,
    record.errorType,
  ].some((field) => (field ?? "").toLowerCase().includes(needle));
}

function sign(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function textCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The persisted ORDER BY mapping (proxy/observe_persist.go). */
function primaryCompare(a: RequestRecord, b: RequestRecord, sort: RequestSort): number {
  switch (sort) {
    case "status":
      return sign(Number(a.success), Number(b.success));
    case "account":
      return textCompare(
        `${a.email ?? ""}${a.accountId}`.toLowerCase(),
        `${b.email ?? ""}${b.accountId}`.toLowerCase(),
      );
    case "api_key":
      return textCompare(
        `${rawKey(a)}${a.apiKeyId ?? ""}`.toLowerCase(),
        `${rawKey(b)}${b.apiKeyId ?? ""}`.toLowerCase(),
      );
    case "model":
      return textCompare(a.model, b.model);
    case "tokens":
      return sign(a.totalTokens, b.totalTokens);
    case "credits":
      return sign(a.credits, b.credits);
    case "duration":
      return sign(a.durationMs ?? 0, b.durationMs ?? 0);
    default:
      return sign(a.ts, b.ts);
  }
}

function sortRecords(
  records: RequestRecord[],
  query: NormalizedQuery,
  tieBreak: (a: RequestRecord, b: RequestRecord) => number,
): RequestRecord[] {
  const direction = query.order === "asc" ? 1 : -1;
  return [...records].sort(
    (a, b) => direction * (primaryCompare(a, b, query.sort) || tieBreak(a, b)),
  );
}

function page(records: RequestRecord[], query: NormalizedQuery, persistent: boolean) {
  const start = Math.min((query.page - 1) * query.pageSize, records.length);
  const body: RecentRequestsResponse = {
    requests: records.slice(start, start + query.pageSize),
    total: records.length,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
    order: query.order,
    persistent,
  };
  return HttpResponse.json(body);
}

const RECENT_REQUESTS = apiUrl("/observe/recent-requests");

/**
 * The in-memory fallback (persistent: false): the newest 200 rows without ids, ties broken by
 * time. Tests install it with mockServer.use(inMemoryRequestsHandler()).
 */
export function inMemoryRequestsHandler(): HttpHandler {
  return http.get(RECENT_REQUESTS, async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const query = normalizeQuery(new URL(request.url));
    indexKeys();
    const ring = mockDb.requests.slice(0, MEMORY_RING_SIZE).map(({ id: _id, ...rest }) => rest);
    const filtered = ring.filter((record) => matches(record, query));
    return page(
      sortRecords(filtered, query, (a, b) => sign(a.ts, b.ts)),
      query,
      false,
    );
  });
}

export const handlers: HttpHandler[] = [
  http.get(RECENT_REQUESTS, async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const query = normalizeQuery(new URL(request.url));
    indexKeys();
    const filtered = mockDb.requests.filter((record) => matches(record, query));
    return page(
      sortRecords(filtered, query, (a, b) => sign(a.id ?? 0, b.id ?? 0)),
      query,
      true,
    );
  }),
];

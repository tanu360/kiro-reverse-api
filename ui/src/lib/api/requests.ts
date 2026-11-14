import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { RecentRequestsParams, RecentRequestsResponse, RequestRecord } from "./types";

/** Empty `search`/`status` are left out of the query string, like the old UI. */
export async function getRecentRequests(
  params: RecentRequestsParams,
): Promise<RecentRequestsResponse> {
  const res = await apiRequest<RecentRequestsResponse>("/observe/recent-requests", {
    query: {
      page: params.page,
      pageSize: params.pageSize,
      search: params.search?.trim(),
      status: params.status,
      errorType: params.errorType,
      conversation: params.conversation,
      sort: params.sort,
      order: params.order,
    },
  });
  return { ...res, requests: res.requests ?? [] };
}

export interface RequestCounts {
  success: number;
  failed: number;
}

/**
 * Requests per status in the whole log (the search does not narrow it), for the Requests tabs:
 * the totals of a one-row page of each status.
 */
export function requestCountsQuery() {
  return queryOptions({
    queryKey: queryKeys.requests.counts(),
    queryFn: async (): Promise<RequestCounts> => {
      const [success, failed] = await Promise.all([
        getRecentRequests({ page: 1, pageSize: 1, status: "success" }),
        getRecentRequests({ page: 1, pageSize: 1, status: "failed" }),
      ]);
      return { success: success.total, failed: failed.total };
    },
  });
}

export function recentRequestsQuery(params: RecentRequestsParams) {
  return queryOptions({
    queryKey: queryKeys.requests.list(params),
    queryFn: () => getRecentRequests(params),
    placeholderData: keepPreviousData,
  });
}

/** One conversation's totals, over the turns logged (at most 500). */
export interface ConversationTotals {
  requests: number;
  successes: number;
  failures: number;
  /** Attempts that moved to another account. */
  failovers: number;
  replays: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  credits: number;
  durationMs: number;
  /** unix s */
  firstTs: number;
  lastTs: number;
  /** Emails (or ids) in the order they first served a turn. */
  accounts: string[];
  models: string[];
  /** Times a turn went to another account than the turn before. */
  accountMoves: number;
}

export interface Conversation {
  id: string;
  /** Oldest first. */
  turns: RequestRecord[];
  totals: ConversationTotals;
  /** More than 500 turns: only the first 500 are listed and counted. */
  truncated: boolean;
}

/** GET /observe/conversations/{id}; 404 `conversation_not_found`. */
export function conversationQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.requests.conversation(id),
    queryFn: () =>
      apiRequest<Conversation>(`/observe/conversations/${encodeURIComponent(id)}`).then((res) => ({
        ...res,
        turns: res.turns ?? [],
      })),
  });
}

/** The kept body of a logged request, with the client's key masked. */
export interface RequestBody {
  endpoint: string;
  size: number;
  model: string;
  stream: boolean;
  body: string;
}

/** GET /observe/requests/{id}/body; 404 `request_body_missing`. */
export function requestBodyQuery(id: number) {
  return queryOptions({
    queryKey: queryKeys.requests.body(id),
    queryFn: () => apiRequest<RequestBody>(`/observe/requests/${id}/body`),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** What a replay answered; `request` is its own new log row, marked with replayOf. */
export interface ReplayResult {
  status: number;
  contentType: string;
  durationMs: number;
  accountId: string;
  model: string;
  /** The JSON answer, when it was JSON. */
  response?: unknown;
  /** Any other answer, as text. */
  responseText?: string;
  request?: RequestRecord;
}

/**
 * POST /observe/requests/{id}/replay: runs the kept body again on `accountId` with `model`,
 * without streaming. It spends credits. 400 `replay_account_invalid`, 404 `request_body_missing`.
 */
export function replayRequest(
  id: number,
  body: { accountId: string; model: string },
): Promise<ReplayResult> {
  return apiRequest(`/observe/requests/${id}/replay`, { method: "POST", body });
}

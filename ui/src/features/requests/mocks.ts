import { type HttpHandler, HttpResponse, http } from "msw";
import type { Conversation, ConversationTotals } from "@/lib/api/requests";
import type { RecentRequestsResponse, RequestRecord, RequestSort } from "@/lib/api/types";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

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
  errorType: string;
  conversation: string;
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
    errorType: (q.get("errorType") ?? "").trim().toLowerCase(),
    conversation: (q.get("conversation") ?? "").trim(),
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
  if (query.errorType && (record.success || record.errorType !== query.errorType)) return false;
  if (query.conversation && record.conversationId !== query.conversation) return false;
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
    record.requestId,
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

  http.get(apiUrl("/observe/conversations/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = String(params.id);
    const turns = mockDb.requests
      .filter((record) => record.conversationId === id)
      .sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
    if (turns.length === 0) {
      return jsonError(404, "no request of this conversation is logged", {
        code: "conversation_not_found",
      });
    }
    const body: Conversation = {
      id,
      turns: turns.slice(0, 500),
      totals: summarize(turns.slice(0, 500)),
      truncated: turns.length > 500,
    };
    return HttpResponse.json(body);
  }),

  http.get(apiUrl("/observe/requests/:id/body"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const record = mockDb.requests.find((item) => item.id === Number(params.id));
    if (!record?.hasBody) {
      return jsonError(404, "this request's body was not kept", { code: "request_body_missing" });
    }
    const text = JSON.stringify(mockBody(record));
    return HttpResponse.json({
      endpoint: record.endpoint ?? "claude",
      size: text.length,
      model: record.model,
      stream: true,
      body: text,
    });
  }),

  // proxy/request_replay.go: the kept body runs again without streaming and is logged anew.
  http.post(apiUrl("/observe/requests/:id/replay"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const original = mockDb.requests.find((item) => item.id === Number(params.id));
    if (!original) return jsonError(404, "request not found", { code: "request_not_found" });
    if (!original.hasBody) {
      return jsonError(404, "this request's body was not kept", { code: "request_body_missing" });
    }
    const input: unknown = await request.json().catch(() => null);
    const { accountId, model } = (input ?? {}) as { accountId?: unknown; model?: unknown };
    const account = mockDb.accounts.find((item) => item.id === (accountId || original.accountId));
    if (!account) {
      return jsonError(400, "choose an account that exists", { code: "replay_account_invalid" });
    }
    const chosenModel = typeof model === "string" && model.trim() ? model.trim() : original.model;
    const nextId = Math.max(0, ...mockDb.requests.map((item) => item.id ?? 0)) + 1;
    const replay: RequestRecord = {
      id: nextId,
      ts: mockNowUnix(),
      accountId: account.id,
      email: account.email,
      model: chosenModel,
      inTokens: original.inTokens,
      outTokens: 96,
      totalTokens: original.inTokens + 96,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits: 0.0124,
      success: true,
      status: 200,
      endpoint: original.endpoint,
      durationMs: 2140,
      requestId: `req_${nextId.toString(16).padStart(24, "0")}`,
      conversationId: chosenModel === original.model ? original.conversationId : undefined,
      replayOf: original.id,
      hasBody: true,
      attempts: [
        {
          accountId: account.id,
          email: account.email,
          endpoint: "kiro",
          startMs: 4,
          durationMs: 2132,
          success: true,
        },
      ],
    };
    mockDb.requests.unshift(replay);
    return HttpResponse.json({
      status: 200,
      contentType: "application/json; charset=utf-8",
      durationMs: replay.durationMs,
      accountId: account.id,
      model: chosenModel,
      response: mockAnswer(replay),
      request: replay,
    });
  }),
];

/** proxy/request_replay.go summarizeConversation. */
function summarize(turns: RequestRecord[]): ConversationTotals {
  const totals: ConversationTotals = {
    requests: 0,
    successes: 0,
    failures: 0,
    failovers: 0,
    replays: 0,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    credits: 0,
    durationMs: 0,
    firstTs: turns[0]?.ts ?? 0,
    lastTs: turns.at(-1)?.ts ?? 0,
    accounts: [],
    models: [],
    accountMoves: 0,
  };
  let last = "";
  for (const turn of turns) {
    totals.requests++;
    if (turn.success) totals.successes++;
    else totals.failures++;
    if (turn.replayOf) totals.replays++;
    totals.failovers += turn.attempts?.filter((attempt) => attempt.failover).length ?? 0;
    totals.inTokens += turn.inTokens;
    totals.outTokens += turn.outTokens;
    totals.cacheReadTokens += turn.cacheReadTokens;
    totals.credits += turn.credits;
    totals.durationMs += turn.durationMs ?? 0;
    const account = turn.email || turn.accountId;
    if (account) {
      if (!totals.accounts.includes(account)) totals.accounts.push(account);
      if (last && last !== account) totals.accountMoves++;
      last = account;
    }
    if (turn.model && !totals.models.includes(turn.model)) totals.models.push(turn.model);
  }
  return totals;
}

/** A plausible client body for a logged request, in its API's shape. */
function mockBody(record: RequestRecord): Record<string, unknown> {
  const messages = [
    {
      role: "user",
      content: "Refactor the retry loop in proxy/kiro.go so each endpoint gets one try.",
    },
  ];
  if (record.endpoint === "responses") {
    return { model: record.model, stream: true, input: messages[0].content };
  }
  if (record.endpoint === "openai") {
    return { model: record.model, stream: true, messages };
  }
  return { model: record.model, max_tokens: 4096, stream: true, messages };
}

/** What a non-streamed answer of the record's API looks like. */
function mockAnswer(record: RequestRecord): Record<string, unknown> {
  const text = "The loop now tries each endpoint once and moves on after the first failure.";
  if (record.endpoint === "openai") {
    return {
      id: `chatcmpl-${record.id}`,
      object: "chat.completion",
      model: record.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: record.inTokens, completion_tokens: record.outTokens },
    };
  }
  if (record.endpoint === "responses") {
    return {
      id: `resp_${record.id}`,
      object: "response",
      model: record.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    };
  }
  return {
    id: `msg_${record.id}`,
    type: "message",
    role: "assistant",
    model: record.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: record.inTokens, output_tokens: record.outTokens },
  };
}

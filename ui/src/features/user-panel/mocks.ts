import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  ApiKeyUsageBreakdownItem,
  ApiKeyUsageEntry,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import type { RequestRecord } from "@/lib/api/types";
import type {
  UserKey,
  UserRequest,
  UserRequestPage,
  UserUsageBreakdown,
} from "@/lib/api/user-panel";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { createRng, hex } from "@/lib/mocks/fixtures";
import { jsonError, mockDelay } from "@/lib/mocks/http";
import { lifetimeGrid } from "@/lib/mocks/lifetime";

// /user/api, as proxy/user_api.go answers it: the API key holder's own panel.
//
// Sign in with the full value of any API key in the mock DB. The deterministic ones:
//   full dataset (the browser default), "Production", near its token and credit limits:
//     sk-6e905b6397eacb0c6f9114936b0d510ceed18d9c2c0fec84e63af0e8e5dd1827
//   small dataset (unit tests, ?mock=small), "team-a":
//     sk-98cfd03d8de6ed9a1c57031c6cb09fdc377e571d02606d8e6c1ba78600c6a6e6
//   both datasets: "kiro-dev-1" (Local dev, no traffic); full only: "demo-key" (Demo, expired).
// Limits, counters, usage and requests are the ones the admin API keys and Requests pages show
// for that key: everything is read from the same mock DB.

type StoredKey = (typeof mockDb.apiKeys)[number];

interface UserSession {
  keyId: string;
  /** The key's value at sign-in: a regenerated key ends the session. */
  key: string;
  /** ms epoch */
  expiresAt: number;
}

const SESSION_TTL_MS = (import.meta.env.VITE_MOCK === "1" ? 30 * 24 : 12) * 3600 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** The browser mock keeps its user sessions here, so a reload stays signed in. */
const SESSIONS_KEY = "kiro_mock_user_sessions";

// The user sign-in has its own guess budget, apart from the admin one (core-handlers.ts).
let failedLogins = 0;
let lockedSince = 0;
let sessions = loadSessions();

function persistent(): boolean {
  return import.meta.env.VITE_MOCK === "1";
}

function loadSessions(): Map<string, UserSession> {
  if (!persistent()) return new Map();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "{}");
    return new Map(Object.entries(raw as Record<string, UserSession>));
  } catch {
    return new Map();
  }
}

function saveSessions(): void {
  if (!persistent()) return;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries(sessions)));
  } catch {
    // Storage blocked: sessions last until the page reloads.
  }
}

/** Forgets every user session and wrong guess (tests). */
export function resetUserPanelMock(): void {
  failedLogins = 0;
  lockedSince = 0;
  sessions = new Map();
  saveSessions();
}

/** '/user/api' + path (USER_API_BASE, not imported so the mocks stay free of the query client). */
function userUrl(path: string): string {
  return `/user/api${path}`;
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** A 429 with Retry-After while the guess budget is spent, as the admin sign-in answers it. */
function guessLimited(): Response | null {
  if (failedLogins < LOGIN_FAILURE_LIMIT) return null;
  const left = lockedSince + LOGIN_LOCK_MS - Date.now();
  if (left > 0) {
    return jsonError(429, "Too many API key attempts; try again later", undefined, {
      "Retry-After": String(Math.max(1, Math.ceil(left / 1000))),
    });
  }
  failedLogins = 0;
  return null;
}

function wrongGuess(): void {
  failedLogins += 1;
  if (failedLogins >= LOGIN_FAILURE_LIMIT) lockedSince = Date.now();
}

function sessionExpired(): Response {
  return jsonError(401, "Unauthorized", { code: "user_session_expired" });
}

/**
 * The key behind X-User-Token, or a 401 for a missing, unknown or expired token, a deleted key
 * or a key whose value changed since the sign-in.
 */
function requireUser(request: Request): { key: StoredKey } | { denied: Response } {
  const token = request.headers.get("X-User-Token") ?? "";
  const session = token ? sessions.get(token) : undefined;
  const key = session ? mockDb.apiKeys.find((k) => k.id === session.keyId) : undefined;
  if (!session || !key || key.key !== session.key || Date.now() >= session.expiresAt) {
    if (session) {
      sessions.delete(token);
      saveSessions();
    }
    return { denied: sessionExpired() };
  }
  return { key };
}

/** The admin apiKeyView's fields a holder may see; zeros and [] instead of omitted fields. */
function keyView(stored: StoredKey): UserKey {
  const expiresAt = stored.expiresAt ?? 0;
  return {
    id: stored.id,
    name: stored.name ?? "",
    keyMasked: stored.keyMasked,
    enabled: stored.enabled,
    expired: expiresAt > 0 && expiresAt <= mockNowUnix(),
    createdAt: stored.createdAt,
    lastUsedAt: stored.lastUsedAt ?? 0,
    expiresAt,
    tokenLimit: stored.tokenLimit ?? 0,
    tokensUsed: stored.tokensUsed,
    creditLimit: stored.creditLimit ?? 0,
    creditsUsed: stored.creditsUsed,
    callLimit: stored.callLimit ?? 0,
    successfulCalls: stored.successfulCalls ?? 0,
    requestsCount: stored.requestsCount,
    rpmLimit: stored.rpmLimit ?? 0,
    allowedModels: [...(stored.allowedModels ?? [])],
    keysRequired: mockDb.settings.requireApiKey,
  };
}

// ---------------------------------------------------------------------------
// Usage: the admin usage mock (features/api/mocks.ts) for this key's records only.
// ---------------------------------------------------------------------------

const USAGE_RANGES: Record<string, { bucket: "hour" | "day"; seconds: number; count: number }> = {
  "24h": { bucket: "hour", seconds: 3600, count: 24 },
  "7d": { bucket: "day", seconds: 86400, count: 7 },
  "30d": { bucket: "day", seconds: 86400, count: 30 },
};

/** The range and tzOffset parameters, validated like the admin usage route. */
function usageParams(request: Request): { range: string; tzOffset: number } | { error: Response } {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "24h";
  if (!USAGE_RANGES[range] && range !== "all") {
    return {
      error: jsonError(400, "range must be 24h, 7d, 30d or all", { code: "invalid_usage_range" }),
    };
  }
  const tzRaw = url.searchParams.get("tzOffset") || "0";
  const tzOffset = Number(tzRaw);
  if (!/^-?\d+$/.test(tzRaw) || Math.abs(tzOffset) > 840) {
    return {
      error: jsonError(400, "tzOffset must be whole minutes between -840 and 840", {
        code: "invalid_tz_offset",
      }),
    };
  }
  return { range, tzOffset };
}

function zeroUsage(): ApiKeyUsageTotals {
  return { requests: 0, succeeded: 0, failed: 0, inTokens: 0, outTokens: 0, tokens: 0, credits: 0 };
}

function addUsage(totals: ApiKeyUsageTotals, record: RequestRecord): void {
  totals.requests += 1;
  if (record.success) totals.succeeded += 1;
  else totals.failed += 1;
  totals.inTokens += record.inTokens;
  totals.outTokens += record.outTokens;
  totals.tokens += record.inTokens + record.outTokens;
  totals.credits += record.credits;
}

/**
 * The admin usage response with only this key in `keys` (absent when it has no traffic in the
 * range, as there). The grid is the admin one: All time starts at the log's oldest record.
 */
function buildUsage(key: StoredKey, range: string, tzOffset: number): ApiKeyUsageResponse {
  const nowUnix = mockNowUnix();
  const spec = USAGE_RANGES[range];
  const off = tzOffset * 60;
  const oldest = mockDb.requests.reduce<number | undefined>(
    (min, record) => (min === undefined || record.ts < min ? record.ts : min),
    undefined,
  );
  const grid = spec ? undefined : lifetimeGrid(oldest, nowUnix, tzOffset);
  const seconds = spec?.seconds ?? 86400;
  const current = Math.floor((nowUnix + off) / seconds);
  const first = current - (spec?.count ?? 1) + 1;
  const from = grid?.from ?? first * seconds - off;
  const to = grid?.to ?? (current + 1) * seconds - off;
  const buckets =
    grid?.buckets ?? Array.from({ length: spec?.count ?? 0 }, (_, i) => from + i * seconds);
  const entry: ApiKeyUsageEntry = {
    id: key.id,
    kind: "key",
    ...(key.name ? { name: key.name } : {}),
    keyMasked: key.keyMasked,
    totals: zeroUsage(),
    series: Array.from({ length: buckets.length }, zeroUsage),
  };
  for (const record of mockDb.requests) {
    if (record.apiKeyId !== key.id || record.ts < from || record.ts >= to) continue;
    const index = grid ? grid.index(record.ts) : Math.floor((record.ts + off) / seconds) - first;
    if (index < 0) continue;
    addUsage(entry.totals, record);
    addUsage(entry.series[index], record);
  }
  return {
    range: range as ApiKeyUsageResponse["range"],
    bucket: grid?.bucket ?? spec?.bucket ?? "day",
    bucketSeconds: grid?.bucketSeconds ?? seconds,
    tzOffset,
    from,
    to,
    nowUnix,
    buckets,
    // As the server: the key's own entry always, with zeros when it has no traffic.
    totals: { ...entry.totals },
    keys: [entry],
  };
}

/** The admin breakdown for ref key:<id>, by model only. */
function buildBreakdown(key: StoredKey, range: string, tzOffset: number): UserUsageBreakdown {
  const usage = buildUsage(key, range, tzOffset);
  const models = new Map<string, ApiKeyUsageBreakdownItem>();
  for (const record of mockDb.requests) {
    if (record.apiKeyId !== key.id || record.ts < usage.from || record.ts >= usage.to) continue;
    const item = models.get(record.model) ?? {
      id: record.model,
      requests: 0,
      succeeded: 0,
      failed: 0,
      tokens: 0,
      credits: 0,
    };
    item.requests += 1;
    if (record.success) item.succeeded += 1;
    else item.failed += 1;
    item.tokens += record.totalTokens;
    item.credits += record.credits;
    models.set(record.model, item);
  }
  return {
    ref: `key:${key.id}`,
    range: usage.range,
    from: usage.from,
    to: usage.to,
    models: [...models.values()].sort(
      (a, b) => b.requests - a.requests || b.credits - a.credits || a.id.localeCompare(b.id),
    ),
    accounts: [],
  };
}

// ---------------------------------------------------------------------------
// Requests: this key's rows of the mock request log, as the admin Requests page lists them.
// ---------------------------------------------------------------------------

/** The mock log carries no request IDs: a stable one per row, like "req_" + 24 hex. */
function requestIdFor(record: RequestRecord): string {
  let seed = 2166136261;
  for (const char of `${record.id ?? 0}:${record.ts}:${record.apiKeyId ?? ""}`) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  }
  return `req_${hex(createRng(seed), 24)}`;
}

/** Only the fields a key holder may see: no account, email, message, attempts or body. */
function requestView(record: RequestRecord): UserRequest {
  return {
    ts: record.ts,
    model: record.model,
    endpoint: record.endpoint ?? "",
    inTokens: record.inTokens,
    outTokens: record.outTokens,
    totalTokens: record.totalTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    credits: record.credits,
    success: record.success,
    status: record.status ?? (record.success ? 200 : 500),
    durationMs: record.durationMs ?? 0,
    errorType: record.success ? "" : (record.errorType ?? "unknown"),
    requestId: record.requestId ?? requestIdFor(record),
  };
}

function positiveInt(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

function listRequests(key: StoredKey, url: URL): UserRequestPage {
  const page = positiveInt(url.searchParams.get("page"), 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    positiveInt(url.searchParams.get("pageSize"), PAGE_SIZE),
  );
  const status = url.searchParams.get("status") ?? "all";
  const rows = mockDb.requests
    .filter(
      (record) =>
        record.apiKeyId === key.id &&
        (status === "success" ? record.success : status === "error" ? !record.success : true),
    )
    .sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0));
  const start = (page - 1) * pageSize;
  return {
    requests: rows.slice(start, start + pageSize).map(requestView),
    total: rows.length,
    page,
    pageSize,
  };
}

async function readKey(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => null);
  const key = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : "";
  return typeof key === "string" ? key.trim() : "";
}

export const handlers: HttpHandler[] = [
  http.post(userUrl("/session"), async ({ request }) => {
    await mockDelay();
    const limited = guessLimited();
    if (limited) return limited;
    const value = await readKey(request);
    if (!value) return jsonError(400, "API key is required", { code: "user_key_required" });
    const key = mockDb.apiKeys.find((k) => k.key === value);
    if (!key) {
      wrongGuess();
      return jsonError(401, "Invalid API key", { code: "user_key_invalid" });
    }
    failedLogins = 0;
    const token = randomHex(64);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { keyId: key.id, key: key.key, expiresAt });
    saveSessions();
    return HttpResponse.json({ token, expiresAt: Math.floor(expiresAt / 1000) });
  }),

  http.delete(userUrl("/session"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    sessions.delete(request.headers.get("X-User-Token") ?? "");
    saveSessions();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(userUrl("/key"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    return HttpResponse.json(keyView(user.key));
  }),

  http.get(userUrl("/usage/breakdown"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    const params = usageParams(request);
    if ("error" in params) return params.error;
    return HttpResponse.json(buildBreakdown(user.key, params.range, params.tzOffset));
  }),

  http.get(userUrl("/usage"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    const params = usageParams(request);
    if ("error" in params) return params.error;
    return HttpResponse.json(buildUsage(user.key, params.range, params.tzOffset));
  }),

  http.get(userUrl("/requests"), async ({ request }) => {
    const user = requireUser(request);
    if ("denied" in user) return user.denied;
    await mockDelay();
    return HttpResponse.json(listRequests(user.key, new URL(request.url)));
  }),
];

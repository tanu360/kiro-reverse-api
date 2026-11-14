import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  ApiKeyUsageBreakdown,
  ApiKeyUsageBreakdownItem,
  ApiKeyUsageEntry,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import type { ApiKey, RequestRecord } from "@/lib/api/types";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";
import { lifetimeGrid } from "@/lib/mocks/lifetime";

// /admin/api/api-keys, as proxy/admin_apikeys.go answers it. The settings endpoints belong to the
// settings feature.

type StoredKey = ApiKey & { key: string };

interface KeyBody {
  name?: unknown;
  key?: unknown;
  enabled?: unknown;
  tokenLimit?: unknown;
  creditLimit?: unknown;
  accountIds?: unknown;
  callLimit?: unknown;
}

/** MaskApiKey (config/apikeys.go): first 6 + "****" + last 4, or the whole key up to 10 chars. */
function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}****${key.slice(-4)}` : key;
}

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `sk-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The list view: never the secret, and zero limits and lastUsedAt omitted like Go. accountIds is
 * always an array and successfulCalls always a number.
 */
function view(stored: StoredKey): ApiKey {
  const { key: _secret, tokenLimit, creditLimit, callLimit, lastUsedAt, name, ...rest } = stored;
  return {
    ...rest,
    accountIds: [...(stored.accountIds ?? [])],
    successfulCalls: stored.successfulCalls ?? 0,
    ...(name ? { name } : {}),
    ...(tokenLimit ? { tokenLimit } : {}),
    ...(creditLimit ? { creditLimit } : {}),
    ...(callLimit ? { callLimit } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
}

async function readBody(request: Request): Promise<KeyBody | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as KeyBody)
    : null;
}

/** int64 decoding: a fractional or non-numeric token limit fails the JSON decode. */
function badTypes(body: KeyBody): boolean {
  const { name, key, enabled, tokenLimit, creditLimit, accountIds, callLimit } = body;
  return (
    (name !== undefined && typeof name !== "string") ||
    (key !== undefined && typeof key !== "string") ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (tokenLimit !== undefined && !Number.isInteger(tokenLimit)) ||
    (creditLimit !== undefined && typeof creditLimit !== "number") ||
    (callLimit !== undefined && !Number.isInteger(callLimit)) ||
    (accountIds !== undefined &&
      (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")))
  );
}

function limitError(body: KeyBody): Response | null {
  if (typeof body.tokenLimit === "number" && body.tokenLimit < 0) {
    return jsonError(400, "token limit must be zero or positive");
  }
  if (typeof body.creditLimit === "number" && body.creditLimit < 0) {
    return jsonError(400, "credit limit must be zero or positive");
  }
  if (typeof body.callLimit === "number" && body.callLimit < 0) {
    return jsonError(400, "call limit must be zero or positive", { code: "call_limit_negative" });
  }
  return null;
}

/**
 * normalizeApiKeyAccountIDsLocked (config/apikey_access.go): trimmed, blanks and duplicates
 * dropped; every id must be an account, or already on the key (a deleted account stays).
 */
function normalizeAccountIds(
  ids: string[],
  previous: readonly string[] = [],
): { ids: string[] } | { error: Response } {
  const known = new Set([...mockDb.accounts.map((a) => a.id), ...previous]);
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || out.includes(id)) continue;
    if (!known.has(id)) {
      return {
        error: jsonError(400, "api key lists an account that does not exist", {
          code: "api_key_unknown_account",
        }),
      };
    }
    out.push(id);
  }
  return { ids: out };
}

function findKey(id: string): StoredKey | undefined {
  return mockDb.apiKeys.find((k) => k.id === id);
}

/**
 * Go's removingKeyLocksOut: disabling or deleting `stored` while keys are required would leave
 * no enabled key, so every client would get 401.
 */
function removingLocksOut(stored: StoredKey | undefined): boolean {
  if (!stored?.enabled || !mockDb.settings.requireApiKey) return false;
  return mockDb.apiKeys.filter((k) => k.enabled).length <= 1;
}

function lockout(): Response {
  return jsonError(409, "would lock out every client", { code: "api_key_lockout" });
}

const USAGE_RANGES: Record<string, { bucket: "hour" | "day"; seconds: number; count: number }> = {
  "24h": { bucket: "hour", seconds: 3600, count: 24 },
  "7d": { bucket: "day", seconds: 86400, count: 7 },
  "30d": { bucket: "day", seconds: 86400, count: 30 },
};

function zeroUsage(): ApiKeyUsageTotals {
  return { requests: 0, succeeded: 0, failed: 0, inTokens: 0, outTokens: 0, tokens: 0, credits: 0 };
}

function addUsage(totals: ApiKeyUsageTotals, record: (typeof mockDb.requests)[number]): void {
  totals.requests += 1;
  if (record.success) totals.succeeded += 1;
  else totals.failed += 1;
  totals.inTokens += record.inTokens;
  totals.outTokens += record.outTokens;
  totals.tokens += record.inTokens + record.outTokens;
  totals.credits += record.credits;
}

/**
 * queryApiKeyUsage (proxy/apikey_usage.go) over the mock request log. The mock records carry
 * only a key ID, so a known ID is its key, an unknown one a deleted key and none "none"; the
 * mock never has invalid keys.
 */
function buildUsage(
  nowUnix: number,
  range: string,
  spec: { bucket: "hour" | "day"; seconds: number; count: number } | undefined,
  tzOffset: number,
): ApiKeyUsageResponse {
  const off = tzOffset * 60;
  // All time (no spec): the server's grid from the oldest mock record. The mock keeps no
  // rollups, so nothing is ever "earlier".
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
  const totals = zeroUsage();
  const entries = new Map<string, ApiKeyUsageEntry>();
  for (const record of mockDb.requests) {
    if (record.ts < from || record.ts >= to) continue;
    const index = grid ? grid.index(record.ts) : Math.floor((record.ts + off) / seconds) - first;
    if (index < 0) continue;
    const id = record.apiKeyId ?? "";
    const stored = id ? findKey(id) : undefined;
    const kind = !id ? "none" : stored ? "key" : "deleted";
    const ref = `${kind}:${id || "none"}`;
    let entry = entries.get(ref);
    if (!entry) {
      entry = {
        id: id || "none",
        kind,
        ...(stored?.name ? { name: stored.name } : {}),
        ...(stored ? { keyMasked: stored.keyMasked } : {}),
        ...(kind === "deleted" && record.apiKeyMasked ? { keyMasked: record.apiKeyMasked } : {}),
        totals: zeroUsage(),
        series: Array.from({ length: buckets.length }, zeroUsage),
      };
      entries.set(ref, entry);
    }
    addUsage(entry.totals, record);
    addUsage(entry.series[index], record);
    addUsage(totals, record);
  }
  const keys = [...entries.values()].sort(
    (a, b) =>
      b.totals.requests - a.totals.requests ||
      b.totals.credits - a.totals.credits ||
      a.id.localeCompare(b.id),
  );
  return {
    range: range as ApiKeyUsageResponse["range"],
    bucket: grid?.bucket ?? spec?.bucket ?? "day",
    bucketSeconds: grid?.bucketSeconds ?? seconds,
    tzOffset,
    from,
    to,
    nowUnix,
    buckets,
    totals,
    keys,
  };
}

/** GET /api-keys/usage/breakdown: one row's records by model and by account (the mock keeps no rollups). */
function buildBreakdown(
  nowUnix: number,
  ref: string,
  range: string,
  spec: { bucket: "hour" | "day"; seconds: number; count: number } | undefined,
  tzOffset: number,
): ApiKeyUsageBreakdown {
  const usage = buildUsage(nowUnix, range, spec, tzOffset);
  const matches = (record: RequestRecord) => {
    const id = record.apiKeyId ?? "";
    if (ref === "none") return !id;
    if (ref === "invalid") return false;
    return id !== "" && ref.endsWith(`:${id}`);
  };
  const models = new Map<string, ApiKeyUsageBreakdownItem>();
  const accounts = new Map<string, ApiKeyUsageBreakdownItem>();
  const add = (map: Map<string, ApiKeyUsageBreakdownItem>, id: string, record: RequestRecord) => {
    const item = map.get(id) ?? { id, requests: 0, succeeded: 0, failed: 0, tokens: 0, credits: 0 };
    item.requests += 1;
    if (record.success) item.succeeded += 1;
    else item.failed += 1;
    item.tokens += record.totalTokens;
    item.credits += record.credits;
    map.set(id, item);
  };
  for (const record of mockDb.requests) {
    if (record.ts < usage.from || record.ts >= usage.to || !matches(record)) continue;
    add(models, record.model, record);
    add(accounts, record.accountId, record);
  }
  const busiest = (a: ApiKeyUsageBreakdownItem, b: ApiKeyUsageBreakdownItem) =>
    b.requests - a.requests || b.credits - a.credits || a.id.localeCompare(b.id);
  const emails = new Map(mockDb.accounts.map((account) => [account.id, account.email]));
  return {
    ref,
    range: usage.range,
    from: usage.from,
    to: usage.to,
    models: [...models.values()].sort(busiest),
    accounts: [...accounts.values()].sort(busiest).map((item) => {
      const email = emails.get(item.id);
      return email ? { ...item, label: email } : item;
    }),
  };
}

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/api-keys/usage/breakdown"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const url = new URL(request.url);
    const ref = url.searchParams.get("ref") ?? "";
    if (!/^(none|invalid|(key|deleted):.+)$/.test(ref)) {
      return jsonError(400, "ref must be key:<id>, deleted:<id>, none or invalid", {
        code: "invalid_usage_ref",
      });
    }
    const range = url.searchParams.get("range") || "24h";
    const spec = USAGE_RANGES[range];
    if (!spec && range !== "all") {
      return jsonError(400, "range must be 24h, 7d, 30d or all", { code: "invalid_usage_range" });
    }
    const tzOffset = Number(url.searchParams.get("tzOffset") || "0") || 0;
    return HttpResponse.json(buildBreakdown(mockNowUnix(), ref, range, spec, tzOffset));
  }),

  http.get(apiUrl("/api-keys"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ apiKeys: mockDb.apiKeys.map(view) });
  }),

  // Before /api-keys/:id, as on the server, or "usage" would be looked up as a key ID.
  http.get(apiUrl("/api-keys/usage"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "24h";
    const spec = USAGE_RANGES[range];
    if (!spec && range !== "all") {
      return jsonError(400, "range must be 24h, 7d, 30d or all", { code: "invalid_usage_range" });
    }
    const tzRaw = url.searchParams.get("tzOffset") || "0";
    const tzOffset = Number(tzRaw);
    if (!/^-?\d+$/.test(tzRaw) || Math.abs(tzOffset) > 840) {
      return jsonError(400, "tzOffset must be whole minutes between -840 and 840", {
        code: "invalid_tz_offset",
      });
    }
    return HttpResponse.json(buildUsage(mockNowUnix(), range, spec, tzOffset));
  }),

  http.get(apiUrl("/api-keys/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const stored = findKey(String(params.id));
    if (!stored) return jsonError(404, "API key not found");
    return HttpResponse.json({ ...view(stored), key: stored.key });
  }),

  http.post(apiUrl("/api-keys"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readBody(request);
    if (!body || badTypes(body)) return jsonError(400, "Invalid JSON");
    const rawKey = typeof body.key === "string" ? body.key : "";
    const customKey = rawKey.trim();
    if (rawKey !== "" && customKey === "") return jsonError(400, "api key value must not be empty");
    const limits = limitError(body);
    if (limits) return limits;
    const accounts = normalizeAccountIds((body.accountIds as string[] | undefined) ?? []);
    if ("error" in accounts) return accounts.error;
    const key = customKey || generateKey();
    if (mockDb.apiKeys.some((k) => k.key === key)) return jsonError(400, "api key already exists");
    const stored: StoredKey = {
      id: crypto.randomUUID(),
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      key,
      keyMasked: maskKey(key),
      enabled: body.enabled !== false,
      createdAt: mockNowUnix(),
      tokenLimit: typeof body.tokenLimit === "number" ? body.tokenLimit : 0,
      creditLimit: typeof body.creditLimit === "number" ? body.creditLimit : 0,
      callLimit: typeof body.callLimit === "number" ? body.callLimit : 0,
      accountIds: accounts.ids,
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
      successfulCalls: 0,
    };
    mockDb.apiKeys.push(stored);
    publishMockEvent("api_keys_changed", stored.id);
    return HttpResponse.json({ success: true, id: stored.id, key, apiKey: view(stored) });
  }),

  // Patch semantics: omitted fields stay, key "" keeps the secret, name "" clears the name.
  http.put(apiUrl("/api-keys/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const stored = findKey(String(params.id));
    if (!stored) return jsonError(404, "API key not found");
    const body = await readBody(request);
    if (!body || badTypes(body)) return jsonError(400, "Invalid JSON");
    const limits = limitError(body);
    if (limits) return limits;
    let nextKey = stored.key;
    if (typeof body.key === "string" && body.key !== "") {
      nextKey = body.key.trim();
      if (!nextKey) return jsonError(400, "api key value must not be empty");
      if (mockDb.apiKeys.some((k) => k.id !== stored.id && k.key === nextKey)) {
        return jsonError(400, "api key value collides with existing entry");
      }
    }
    let accountIds = stored.accountIds ?? [];
    if (Array.isArray(body.accountIds)) {
      const accounts = normalizeAccountIds(body.accountIds as string[], accountIds);
      if ("error" in accounts) return accounts.error;
      accountIds = accounts.ids;
    }
    if (body.enabled === false && removingLocksOut(stored)) return lockout();
    if (typeof body.name === "string") stored.name = body.name.trim() || undefined;
    if (typeof body.callLimit === "number") stored.callLimit = body.callLimit;
    stored.accountIds = accountIds;
    if (typeof body.enabled === "boolean") stored.enabled = body.enabled;
    if (typeof body.tokenLimit === "number") stored.tokenLimit = body.tokenLimit;
    if (typeof body.creditLimit === "number") stored.creditLimit = body.creditLimit;
    stored.key = nextKey;
    stored.keyMasked = maskKey(nextKey);
    publishMockEvent("api_keys_changed", stored.id);
    return HttpResponse.json({ success: true, apiKey: view(stored) });
  }),

  // Go answers 200 for an unknown id too.
  http.delete(apiUrl("/api-keys/:id"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const id = String(params.id);
    if (removingLocksOut(findKey(id))) return lockout();
    mockDb.apiKeys = mockDb.apiKeys.filter((k) => k.id !== id);
    publishMockEvent("api_keys_changed", id);
    return HttpResponse.json({ success: true });
  }),

  // Zeroes the counters, keeps lastUsedAt and does not enable a key its limit disabled.
  http.post(apiUrl("/api-keys/:id/reset-usage"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const stored = findKey(String(params.id));
    if (!stored) return jsonError(404, "api key not found");
    stored.tokensUsed = 0;
    stored.creditsUsed = 0;
    stored.requestsCount = 0;
    stored.successfulCalls = 0;
    publishMockEvent("api_keys_changed", stored.id);
    return HttpResponse.json({ success: true, apiKey: view(stored) });
  }),

  // A fresh secret; id, name, state, limits, usage and accounts stay.
  http.post(apiUrl("/api-keys/:id/regenerate"), async ({ request, params }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const stored = findKey(String(params.id));
    if (!stored) return jsonError(404, "API key not found", { code: "api_key_not_found" });
    let key = generateKey();
    while (mockDb.apiKeys.some((k) => k.key === key)) key = generateKey();
    stored.key = key;
    stored.keyMasked = maskKey(key);
    publishMockEvent("api_keys_changed", stored.id);
    return HttpResponse.json({ success: true, id: stored.id, key, apiKey: view(stored) });
  }),
];

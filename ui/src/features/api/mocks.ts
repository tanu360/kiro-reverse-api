import { type HttpHandler, HttpResponse, http } from "msw";
import type { ApiKey } from "@/lib/api/types";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

// /admin/api/api-keys, as proxy/admin_apikeys.go answers it. The settings endpoints belong to the
// settings feature.

type StoredKey = ApiKey & { key: string };

interface KeyBody {
  name?: unknown;
  key?: unknown;
  enabled?: unknown;
  tokenLimit?: unknown;
  creditLimit?: unknown;
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

/** The list view: never the secret, and zero limits and lastUsedAt omitted like Go. */
function view(stored: StoredKey): ApiKey {
  const { key: _secret, tokenLimit, creditLimit, lastUsedAt, name, ...rest } = stored;
  return {
    ...rest,
    ...(name ? { name } : {}),
    ...(tokenLimit ? { tokenLimit } : {}),
    ...(creditLimit ? { creditLimit } : {}),
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
  const { name, key, enabled, tokenLimit, creditLimit } = body;
  return (
    (name !== undefined && typeof name !== "string") ||
    (key !== undefined && typeof key !== "string") ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (tokenLimit !== undefined && !Number.isInteger(tokenLimit)) ||
    (creditLimit !== undefined && typeof creditLimit !== "number")
  );
}

function limitError(body: KeyBody): Response | null {
  if (typeof body.tokenLimit === "number" && body.tokenLimit < 0) {
    return jsonError(400, "token limit must be zero or positive");
  }
  if (typeof body.creditLimit === "number" && body.creditLimit < 0) {
    return jsonError(400, "credit limit must be zero or positive");
  }
  return null;
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

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/api-keys"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ apiKeys: mockDb.apiKeys.map(view) });
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
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
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
    if (body.enabled === false && removingLocksOut(stored)) return lockout();
    if (typeof body.name === "string") stored.name = body.name.trim() || undefined;
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
    publishMockEvent("api_keys_changed", stored.id);
    return HttpResponse.json({ success: true, apiKey: view(stored) });
  }),
];

import { beforeEach, describe, expect, it } from "vitest";
import type { ApiKeyUsageBreakdown, ApiKeyUsageResponse } from "@/lib/api/api-key-usage";
import { apiRequest } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import {
  getUserKey,
  getUserRequests,
  getUserUsage,
  getUserUsageBreakdown,
  signInWithKey,
  signOutUser,
} from "@/lib/api/user-panel";
import { setSession } from "@/lib/auth/session";
import { getUserToken } from "@/lib/auth/user-session";
import { mockDb } from "@/lib/mocks/db";
import { resetUserPanelMock } from "./mocks";

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

function code(error: ApiError): unknown {
  return (error.body as { code?: unknown } | null)?.code;
}

beforeEach(() => {
  resetUserPanelMock();
  setSession({ token: "mock-admin", expiresAt: 0, remember: false });
});

describe("user panel mock", () => {
  it("signs in with the full value of a key and shows only that key", async () => {
    const stored = mockDb.apiKeys[0];
    expect(stored.key).toBe("sk-98cfd03d8de6ed9a1c57031c6cb09fdc377e571d02606d8e6c1ba78600c6a6e6");
    await signInWithKey(` ${stored.key} `, false);
    expect(getUserToken()).toMatch(/^[0-9a-f]{64}$/);
    const key = await getUserKey();
    expect(key).toMatchObject({
      id: stored.id,
      name: "team-a",
      keyMasked: stored.keyMasked,
      tokenLimit: 2_000_000,
      tokensUsed: 1_874_210,
      creditLimit: 50,
      creditsUsed: 46.2,
      requestsCount: 412,
      allowedModels: [],
    });
    expect(JSON.stringify(key)).not.toContain(stored.key);
  });

  it("answers a missing key with 400 and a wrong one with 401, then locks out", async () => {
    expect(code(await rejection(signInWithKey("", false)))).toBe("user_key_required");
    for (let i = 0; i < 5; i++) {
      const error = await rejection(signInWithKey(`sk-wrong-${i}`, false));
      expect([error.status, code(error)]).toEqual([401, "user_key_invalid"]);
    }
    const locked = await rejection(signInWithKey(mockDb.apiKeys[0].key, false));
    expect(locked.status).toBe(429);
    expect(locked.retryAfter).toBeGreaterThan(0);
    expect(locked.body).toEqual({ error: "Too many API key attempts; try again later" });
  });

  it("ends the session for an unknown token, a regenerated key and a sign-out", async () => {
    await signInWithKey(mockDb.apiKeys[0].key, true);
    mockDb.apiKeys[0].key = "sk-regenerated";
    const error = await rejection(getUserKey());
    expect([error.status, code(error)]).toEqual([401, "user_session_expired"]);
    expect(getUserToken()).toBeNull();

    await signInWithKey("sk-regenerated", true);
    await signOutUser();
    localStorage.setItem("kiro_user_token", "f".repeat(64));
    expect(code(await rejection(getUserKey()))).toBe("user_session_expired");
  });

  it("serves the same usage and models as the admin API page for the key", async () => {
    const stored = mockDb.apiKeys[0];
    await signInWithKey(stored.key, false);
    for (const range of ["24h", "all"] as const) {
      const admin = await apiRequest<ApiKeyUsageResponse>("/api-keys/usage", {
        query: { range, tzOffset: 330 },
      });
      const entry = admin.keys.find((row) => row.kind === "key" && row.id === stored.id);
      const usage = await getUserUsage(range, 330);
      expect(usage.buckets).toEqual(admin.buckets);
      expect(usage.keys).toEqual([entry]);
      expect(usage.totals).toEqual(entry?.totals);

      const adminModels = await apiRequest<ApiKeyUsageBreakdown>("/api-keys/usage/breakdown", {
        query: { ref: `key:${stored.id}`, range, tzOffset: 330 },
      });
      const breakdown = await getUserUsageBreakdown(range, 330);
      expect(breakdown.models).toEqual(adminModels.models);
      expect(breakdown.accounts).toEqual([]);
    }
    expect(code(await rejection(getUserUsage("1y" as "24h", 0)))).toBe("invalid_usage_range");
  });

  it("lists the key's requests newest first, by page and status", async () => {
    const stored = mockDb.apiKeys[0];
    await signInWithKey(stored.key, false);
    const mine = mockDb.requests.filter((row) => row.apiKeyId === stored.id);
    const first = await getUserRequests({ page: 1, pageSize: 10 });
    expect(first).toMatchObject({ total: mine.length, page: 1, pageSize: 10 });
    expect(first.requests).toHaveLength(10);
    const ts = first.requests.map((row) => row.ts);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
    expect(first.requests[0].requestId).toMatch(/^req_[0-9a-f]{24}$/);
    expect(JSON.stringify(first)).not.toMatch(/accountId|email|message/);

    const failed = await getUserRequests({ status: "error", pageSize: 100 });
    expect(failed.total).toBe(mine.filter((row) => !row.success).length);
    expect(failed.total).toBeGreaterThan(0);
    expect(failed.requests.every((row) => !row.success && row.errorType !== "")).toBe(true);
    const ok = await getUserRequests({ status: "success", pageSize: 100 });
    expect(ok.total + failed.total).toBe(mine.length);
    expect(new Set(ok.requests.map((row) => row.model)).size).toBeGreaterThan(1);
  });
});

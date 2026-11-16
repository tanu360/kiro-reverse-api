import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  USER_API_BASE,
  type UserRequest,
} from "@/lib/api/user-panel";
import { setSession } from "@/lib/auth/session";
import { getUserToken, USER_TOKEN_EXP_KEY } from "@/lib/auth/user-session";
import { mockDb } from "@/lib/mocks/db";
import { DEMO_KEYS, type DemoKeyId, resetUserPanelMock } from "./mocks";

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

afterEach(() => {
  vi.useRealTimers();
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
    // Every tab's answer counts the key's whole log, as the server does.
    const counts = { all: mine.length, succeeded: ok.total, failed: failed.total };
    for (const page of [first, failed, ok]) expect(page.counts).toEqual(counts);
  });
});

function demoValue(id: DemoKeyId): string {
  const found = DEMO_KEYS.find((demo) => demo.id === id);
  if (!found) throw new Error(`no demo key ${id}`);
  return found.key;
}

/** Signs in with a demo key and returns its key view. */
async function demo(id: DemoKeyId) {
  await signInWithKey(demoValue(id), false);
  return getUserKey();
}

const nowSec = () => Date.now() / 1000;

describe("user panel mock demo keys", () => {
  it("are short, unique and apart from the admin pages' keys", async () => {
    expect(DEMO_KEYS.map((key) => key.id)).toEqual([
      "active",
      "nearLimit",
      "overLimit",
      "off",
      "expired",
      "expiring",
      "restricted",
      "new",
      "heavy",
      "usageBusy",
      "requestsError",
      "openServer",
      "shortSession",
    ]);
    const values = DEMO_KEYS.map((key) => key.key);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => /^sk-demo-[a-z-]+$/.test(value))).toBe(true);
    expect(mockDb.apiKeys.some((key) => values.includes(key.key))).toBe(false);
    // A near miss is a wrong guess like any other.
    const wrong = await rejection(signInWithKey("sk-demo-nope", false));
    expect([wrong.status, code(wrong)]).toEqual([401, "user_key_invalid"]);
  });

  it("signs each one in, masked, with counters that cover its whole log", async () => {
    for (const { id, key } of DEMO_KEYS) {
      await signInWithKey(key, false);
      const view = await getUserKey();
      expect(view.keyMasked).toBe(`${key.slice(0, 6)}****${key.slice(-4)}`);
      expect(JSON.stringify(view)).not.toContain(key);
      if (id === "usageBusy") continue;
      const all = await getUserUsage("all", 0);
      expect(view.tokensUsed).toBeGreaterThanOrEqual(all.totals.tokens);
      expect(view.creditsUsed).toBeGreaterThanOrEqual(all.totals.credits - 1e-6);
      expect(view.requestsCount).toBeGreaterThanOrEqual(all.totals.requests);
      expect(view.successfulCalls).toBeGreaterThanOrEqual(all.totals.succeeded);
      expect(all.keys.map((entry) => entry.id)).toEqual([view.id]);
      if (id === "requestsError") continue;
      const rows = await getUserRequests({ pageSize: 100 });
      expect(rows.total).toBe(all.totals.requests);
      const ts = rows.requests.map((row) => row.ts);
      expect(ts).toEqual([...ts].sort((a, b) => b - a));
      expect(JSON.stringify(rows)).not.toMatch(/accountId|demo-account|email|message/);
    }
  });

  it("counts each one's status tabs and sorts its log as the server does", async () => {
    const sorts = {
      status: (row: UserRequest) => Number(row.success),
      tokens: (row: UserRequest) => row.totalTokens,
      credits: (row: UserRequest) => row.credits,
      duration: (row: UserRequest) => row.durationMs,
    } as const;
    for (const { id, key } of DEMO_KEYS) {
      if (id === "requestsError") continue;
      await signInWithKey(key, false);
      const all = await getUserRequests({ pageSize: 100 });
      const failed = await getUserRequests({ status: "error", pageSize: 1 });
      const counts = { all: all.total, succeeded: all.total - failed.total, failed: failed.total };
      expect(all.counts).toEqual(counts);
      expect(failed.counts).toEqual(counts);
      for (const [sort, value] of Object.entries(sorts)) {
        for (const order of ["asc", "desc"] as const) {
          const page = await getUserRequests({
            pageSize: 100,
            sort: sort as keyof typeof sorts,
            order,
          });
          expect([page.sort, page.order, page.total]).toEqual([sort, order, all.total]);
          const values = page.requests.map(value);
          const sorted = [...values].sort((a, b) => (order === "asc" ? a - b : b - a));
          expect(values).toEqual(sorted);
        }
      }
      const models = (
        await getUserRequests({ pageSize: 100, sort: "model", order: "asc" })
      ).requests.map((row) => row.model);
      expect(models).toEqual([...models].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      // An account sort is not a holder's: the answer is time, newest first.
      const account = await getUserRequests({ pageSize: 100, sort: "account" as "time" });
      expect(account.sort).toBe("time");
      expect(account.requests.map((row) => row.requestId)).toEqual(
        all.requests.map((row) => row.requestId),
      );
    }
  });

  it("active: everyday traffic over several models, a few failures, cache tokens", async () => {
    const view = await demo("active");
    expect(view).toMatchObject({
      name: "Web app",
      enabled: true,
      expired: false,
      expiresAt: 0,
      tokenLimit: 50_000_000,
      creditLimit: 1_500,
      callLimit: 0,
      rpmLimit: 0,
      allowedModels: [],
      keysRequired: true,
    });
    expect(view.tokensUsed / view.tokenLimit).toBeGreaterThan(0.05);
    expect(view.tokensUsed / view.tokenLimit).toBeLessThan(0.6);
    expect(view.lastUsedAt).toBeGreaterThan(nowSec() - 3600);
    expect((await getUserUsage("24h", 0)).totals.requests).toBeGreaterThan(30);
    expect((await getUserUsageBreakdown("30d", 0)).models.length).toBeGreaterThanOrEqual(5);
    const all = await getUserRequests({ pageSize: 100 });
    const failed = await getUserRequests({ status: "error", pageSize: 100 });
    expect(failed.total).toBeGreaterThan(3);
    expect(failed.total / all.total).toBeLessThan(0.1);
    expect(new Set(failed.requests.map((row) => row.errorType)).size).toBeGreaterThan(2);
    expect(all.requests.some((row) => row.cacheReadTokens > 0)).toBe(true);
    expect(all.requests.some((row) => row.cacheWriteTokens > 0)).toBe(true);
    for (const row of all.requests) {
      expect(row.cacheReadTokens + row.cacheWriteTokens).toBeLessThanOrEqual(row.inTokens);
    }
  });

  it("near and over limits", async () => {
    const near = await demo("nearLimit");
    expect(near.tokensUsed / near.tokenLimit).toBeCloseTo(0.95, 2);
    expect(near.creditsUsed / near.creditLimit).toBeCloseTo(0.98, 2);
    expect(near.successfulCalls / near.callLimit).toBeCloseTo(0.9, 2);

    const over = await demo("overLimit");
    expect(over.tokensUsed).toBeGreaterThan(over.tokenLimit);
    const [latest] = (await getUserRequests({ pageSize: 10 })).requests;
    expect(latest).toMatchObject({
      success: false,
      status: 429,
      errorType: "api_key_limit",
      model: "",
    });
  });

  it("turned off, expired and expiring soon", async () => {
    const off = await demo("off");
    expect([off.enabled, off.expired]).toEqual([false, false]);
    const [refused] = (await getUserRequests({ pageSize: 10 })).requests;
    expect(refused).toMatchObject({ success: false, status: 401, errorType: "auth" });
    expect(off.lastUsedAt).toBeLessThan(refused.ts);

    const expired = await demo("expired");
    expect([expired.enabled, expired.expired]).toEqual([true, true]);
    expect(expired.expiresAt).toBeLessThan(nowSec() - 3 * 86_400 + 1);
    expect(expired.expiresAt).toBeGreaterThan(nowSec() - 3 * 86_400 - 3600);
    const rows = (await getUserRequests({ pageSize: 100 })).requests;
    expect(rows[0]).toMatchObject({ success: false, status: 401, errorType: "auth" });
    expect(rows.filter((row) => row.ts > expired.expiresAt).every((row) => !row.success)).toBe(
      true,
    );

    const expiring = await demo("expiring");
    expect([expiring.enabled, expiring.expired]).toEqual([true, false]);
    const left = expiring.expiresAt - nowSec();
    expect(left).toBeGreaterThanOrEqual(2 * 86_400 - 1);
    expect(left).toBeLessThanOrEqual(2 * 86_400 + 3600);
  });

  it("restricted: two allowed models and a rate limit", async () => {
    const view = await demo("restricted");
    expect(view.allowedModels).toEqual(["claude-haiku-4.5", "claude-sonnet-5"]);
    expect(view.rpmLimit).toBe(30);
    const models = (await getUserUsageBreakdown("30d", 0)).models.map((item) => item.id);
    expect(models.every((model) => ["", ...view.allowedModels].includes(model))).toBe(true);
    const failed = await getUserRequests({ status: "error", pageSize: 100 });
    expect(
      failed.requests.some((row) => row.status === 429 && row.errorType === "rate_limit"),
    ).toBe(true);
  });

  it("new: no name, never used, and every list empty", async () => {
    const view = await demo("new");
    expect(view).toMatchObject({
      name: "",
      lastUsedAt: 0,
      tokensUsed: 0,
      creditsUsed: 0,
      requestsCount: 0,
      successfulCalls: 0,
    });
    for (const range of ["24h", "7d", "30d", "all"] as const) {
      const usage = await getUserUsage(range, 0);
      expect(usage.totals.requests).toBe(0);
      expect(usage.keys).toHaveLength(1);
      expect(usage.keys[0].series.every((bucket) => bucket.requests === 0)).toBe(true);
      expect((await getUserUsageBreakdown(range, 0)).models).toEqual([]);
    }
    for (const status of ["all", "success", "error"] as const) {
      expect(await getUserRequests({ status })).toMatchObject({ requests: [], total: 0 });
    }
  });

  it("heavy: a long unicode name, huge numbers, long model names and many pages", async () => {
    const view = await demo("heavy");
    expect([...view.name].length).toBeGreaterThan(100);
    expect(view.name).toMatch(/🚀/u);
    expect(view.name).toMatch(/\p{Script=Han}/u);
    expect(view.tokensUsed).toBeGreaterThan(1e9);
    expect(view.creditsUsed).toBeGreaterThan(10_000);
    expect(view.requestsCount).toBeGreaterThan(1e6);
    const first = await getUserRequests({ pageSize: 100 });
    expect(first.total).toBeGreaterThanOrEqual(600);
    const last = Math.ceil(first.total / 100);
    expect((await getUserRequests({ page: last, pageSize: 100 })).requests.length).toBeGreaterThan(
      0,
    );
    expect((await getUserRequests({ page: last + 1, pageSize: 100 })).requests).toEqual([]);
    const models = (await getUserUsageBreakdown("all", 0)).models.map((item) => item.id);
    expect(Math.max(...models.map((model) => model.length))).toBeGreaterThan(60);
    const all = await getUserUsage("all", 0);
    expect(all.bucket).toBe("week");
    expect(all.totals.tokens).toBeGreaterThan(1e8);
  });

  it("usage busy and requests failing, while the other routes answer", async () => {
    await demo("usageBusy");
    for (const call of [getUserUsage("24h", 0), getUserUsageBreakdown("24h", 0)]) {
      const busy = await rejection(call);
      expect([busy.status, code(busy), busy.retryAfter]).toEqual([429, "user_usage_busy", 60]);
    }
    expect((await getUserRequests()).total).toBeGreaterThan(0);
    expect(getUserToken()).not.toBeNull();

    await demo("requestsError");
    const failed = await rejection(getUserRequests());
    expect([failed.status, code(failed)]).toEqual([500, "internal_error"]);
    expect((await getUserUsage("7d", 0)).totals.requests).toBeGreaterThan(0);
    expect((await getUserUsageBreakdown("7d", 0)).models.length).toBeGreaterThan(0);
    expect(getUserToken()).not.toBeNull();
  });

  it("open server: keysRequired is off for that key only", async () => {
    expect((await demo("openServer")).keysRequired).toBe(false);
    expect((await demo("active")).keysRequired).toBe(true);
    // The admin keys still follow the server's setting.
    mockDb.settings.requireApiKey = false;
    await signInWithKey(mockDb.apiKeys[0].key, false);
    expect((await getUserKey()).keysRequired).toBe(false);
    expect((await demo("active")).keysRequired).toBe(true);
  });

  it("short session: ends 30 seconds after sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await signInWithKey(demoValue("active"), false);
    const longExp = Number(sessionStorage.getItem(USER_TOKEN_EXP_KEY));
    expect(longExp - Date.now()).toBeGreaterThan(3600 * 1000);

    await signInWithKey(demoValue("shortSession"), false);
    const exp = Number(sessionStorage.getItem(USER_TOKEN_EXP_KEY));
    expect(exp - Date.now()).toBeGreaterThan(25_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(30_000);
    const token = getUserToken() ?? "";
    expect((await getUserKey()).name).toBe("Kiosk");

    vi.setSystemTime(Date.now() + 31_000);
    // The server ends it too, whatever the browser kept.
    const server = await rejection(
      apiRequest("/key", { auth: false, base: USER_API_BASE, headers: { "X-User-Token": token } }),
    );
    expect([server.status, code(server)]).toEqual([401, "user_session_expired"]);
    const local = await rejection(getUserKey());
    expect(code(local)).toBe("user_session_expired");
    expect(getUserToken()).toBeNull();
  });
});

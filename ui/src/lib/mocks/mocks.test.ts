import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { createSession, getFirstRun } from "@/lib/api/session";
import { compareVersions, fetchRemoteVersion, getStatus, getVersion } from "@/lib/api/system";
import type { RequestErrorType } from "@/lib/api/types";
import { setSession } from "@/lib/auth/session";
import { mockDb, mockNowUnix, resetMockDb } from "./db";
import {
  buildHeatmap,
  buildModelMix,
  buildOverview,
  makeAccount,
  makeRequestRecord,
  seedAccounts,
  seedRequests,
} from "./fixtures";

const ERROR_TYPES: RequestErrorType[] = [
  "client_closed",
  "api_key_limit",
  "overage",
  "quota",
  "suspended",
  "profile",
  "auth",
  "stream",
  "no_accounts",
  "invalid_request",
  "rate_limit",
  "timeout",
  "upstream",
  "unknown",
];

describe("mock database", () => {
  it("re-seeds in place, keeping the object identity", () => {
    const ref = mockDb;
    const seededIds = mockDb.accounts.map((a) => a.id);
    mockDb.accounts.push(makeAccount());
    mockDb.firstRunPending = false;
    mockDb.failedLogins = 3;
    resetMockDb();
    expect(mockDb).toBe(ref);
    expect(mockDb.accounts.map((a) => a.id)).toEqual(seededIds);
    expect(mockDb.firstRunPending).toBe(true);
    expect(mockDb.failedLogins).toBe(0);
    expect(mockDb.adminPassword).toBe("12345678");
  });

  it("seeds the same data every time", () => {
    const now = mockNowUnix();
    expect(seedRequests(now, 320)).toEqual(seedRequests(now, 320));
    expect(seedAccounts().map((a) => a.id)).toEqual(seedAccounts().map((a) => a.id));
  });

  it("includes an account for every state the UI handles", () => {
    const now = mockNowUnix();
    const accounts = mockDb.accounts;
    expect(accounts).toHaveLength(8);
    const find = (predicate: (a: (typeof accounts)[number]) => boolean) =>
      expect(accounts.some(predicate)).toBe(true);
    find((a) => a.authMethod === "idc" && a.provider === "Enterprise" && a.usagePercent === 0.45);
    find(
      (a) =>
        a.provider === "BuilderId" &&
        a.usagePercent === 0.92 &&
        a.overageStatus === "ENABLED" &&
        a.weight === 3,
    );
    find((a) => a.authMethod === "social" && a.provider === "Google" && a.expiresAt < now);
    find((a) => a.banStatus === "BANNED" && !a.enabled);
    find((a) => a.banStatus === "SUSPENDED");
    find(
      (a) =>
        a.authMethod === "api_key" &&
        a.expiresAt === 0 &&
        a.usageLimit === 0 &&
        a.region === "us-east-1",
    );
    find(
      (a) =>
        a.authMethod === "external_idp" &&
        a.profileArnPinned &&
        a.trialStatus === "ACTIVE" &&
        a.trialExpiresAt > now + 2 * 86_400 &&
        a.trialExpiresAt <= now + 3 * 86_400 &&
        a.overageCapability === "NOT_OVERAGE_CAPABLE",
    );
    find((a) => a.enabled && !a.hasToken && a.email === "");
    expect(accounts.filter((a) => a.nickname).length).toBe(2);
    expect(Object.keys(mockDb.secrets)).toHaveLength(8);
  });

  it("seeds 320 requests covering endpoints, models, failures and durations", () => {
    const requests = mockDb.requests;
    expect(requests).toHaveLength(320);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].ts).toBeLessThanOrEqual(requests[i - 1].ts);
    }
    expect(requests.at(-1)?.ts).toBeGreaterThanOrEqual(mockNowUnix() - 86_400 - 60);
    expect(new Set(requests.map((r) => r.endpoint).filter(Boolean))).toEqual(
      new Set(["claude", "openai", "responses"]),
    );
    expect(new Set(requests.map((r) => r.model).filter(Boolean)).size).toBe(6);
    const failures = requests.filter((r) => !r.success);
    expect(failures.length / requests.length).toBeGreaterThan(0.06);
    expect(failures.length / requests.length).toBeLessThan(0.1);
    expect(new Set(failures.map((r) => r.errorType))).toEqual(new Set(ERROR_TYPES));
    const authRows = requests.filter(
      (r) =>
        !r.success && r.accountId === "" && r.model === "" && [401, 429].includes(r.status ?? 0),
    );
    expect(authRows).toHaveLength(3);
    expect(requests.slice(0, 25).some((r) => authRows.includes(r))).toBe(true);
    expect(requests.some((r) => r.durationMs === undefined)).toBe(true);
    expect(requests.some((r) => r.cacheReadTokens > 0)).toBe(true);
    expect(requests.some((r) => r.cacheWriteTokens > 0)).toBe(true);
  });

  it("seeds errors, API keys, backups and settings", () => {
    expect(mockDb.errors).toHaveLength(40);
    expect(mockDb.apiKeys).toHaveLength(4);
    expect(mockDb.apiKeys.some((k) => k.name === "team-a" && k.tokenLimit && k.creditLimit)).toBe(
      true,
    );
    expect(mockDb.apiKeys.some((k) => !k.name && !k.tokenLimit && !k.creditLimit)).toBe(true);
    expect(mockDb.apiKeys.some((k) => !k.enabled && (k.tokenLimit ?? 0) <= k.tokensUsed)).toBe(
      true,
    );
    expect(mockDb.apiKeys.some((k) => k.key.length <= 10 && k.keyMasked === k.key)).toBe(true);
    expect(mockDb.backups.map((b) => b.kind).sort()).toEqual(
      ["auto", "manual", "pre-restore", "pre-restore", "scheduled", "scheduled"].sort(),
    );
    expect(mockDb.backups.some((b) => b.note?.startsWith("auto before restore "))).toBe(true);
    expect(mockDb.backups.some((b) => b.note === "upload kiro-backup-x.json")).toBe(true);
    expect(mockDb.schedule).toMatchObject({ enabled: true, cadence: "daily", keep: 14 });
    expect(mockDb.modelMappings).toHaveLength(9);
    expect(mockDb.proxy.proxyURL).toBe("socks5://user:p%40ss@127.0.0.1:1080");
    expect(mockDb.promptFilter.rules.map((r) => r.type)).toEqual(["regex", "lines-containing"]);
  });
});

describe("observe builders", () => {
  const now = 1_800_000_030; // 30 s into a minute
  const accountId = "acc-1";
  const requests = [
    makeRequestRecord({ ts: now, accountId, credits: 0.5 }),
    makeRequestRecord({ ts: now - 3 * 60, accountId, success: false, credits: 0 }),
    makeRequestRecord({ ts: now - 2 * 3600, accountId }),
  ];

  it("buildHeatmap returns windowMin cells with offset 0 = the current minute", () => {
    const heatmap = buildHeatmap(
      requests,
      [makeAccount({ id: accountId, email: "a@b.io" })],
      60,
      now,
    );
    expect(heatmap.global.accountId).toBe("_global_");
    expect(heatmap.global.cells).toHaveLength(60);
    expect(heatmap.global.cells[0]).toEqual({ offset: 0, reqs: 1, failures: 0, credits: 0.5 });
    expect(heatmap.global.cells[3]).toEqual({ offset: 3, reqs: 1, failures: 1 });
    expect(heatmap.accounts).toEqual([expect.objectContaining({ accountId, email: "a@b.io" })]);
    expect(heatmap.accounts[0].cells).toHaveLength(60);
    expect(buildHeatmap([], [], 120, now).accounts).toEqual([]);
  });

  it("buildOverview counts the 1, 5 and 60 minute windows", () => {
    const overview = buildOverview(requests, now, now - 86_400);
    expect(overview.rpm1).toBe(1);
    expect(overview.rpm5Avg).toBe(2 / 5);
    expect(overview.errRate5).toBe(0.5);
    expect(overview.errors60).toBe(1);
    expect(overview.successes60).toBe(1);
    expect(overview.activeAccts).toBe(1);
    expect(overview.totalAccts).toBe(1);
  });

  it("buildModelMix counts failures only as requests", () => {
    const [entry] = buildModelMix(requests);
    expect(entry.reqs).toBe(3);
    expect(entry.inTokens).toBe(2400);
  });
});

describe("core handlers", () => {
  it("signs in with the first-run password, then hides it", async () => {
    await expect(getFirstRun()).resolves.toEqual({ password: "12345678" });
    const session = await createSession("12345678");
    expect(session.token).toMatch(/^mock-/);
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);
    await expect(getFirstRun()).resolves.toEqual({ password: "" });
  });

  it("answers the 6th wrong password with 429 and Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const error = await createSession("wrong").catch((e: unknown) => e);
      expect((error as ApiError).status).toBe(401);
    }
    const error = await createSession("wrong").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfter).toBe(60);
  });

  it("requires a mock token for /status", async () => {
    await expect(getStatus()).rejects.toMatchObject({ status: 401 });
    setSession({ token: "mock-reload", expiresAt: Date.now() + 3_600_000, remember: false });
    const status = await getStatus();
    expect(status.accounts).toBe(8);
    expect(status.totalRequests).toBe(320);
    expect(status.totalBanned).toBe(2);
  });

  it("serves a remote version equal to the running one", async () => {
    setSession({ token: "mock-reload", expiresAt: Date.now() + 3_600_000, remember: false });
    const local = await getVersion();
    const remote = await fetchRemoteVersion();
    expect(local.version).toBe("v2.1.0");
    expect(compareVersions(local.version, remote.version)).toBe(0);
  });
});

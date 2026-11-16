import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { setSession } from "@/lib/auth/session";
import {
  getUserToken,
  setUserToken,
  subscribeUserSession,
  USER_TOKEN_KEY,
  type UserSessionChangeReason,
} from "@/lib/auth/user-session";
import { mockServer } from "@/lib/mocks/node";
import { queryClient } from "@/lib/query-client";
import { ApiError } from "./errors";
import { queryKeys } from "./query-keys";
import type { ApiKey } from "./types";
import {
  getUserKey,
  getUserRequests,
  normalizeUserKey,
  normalizeUserRequest,
  normalizeUserRequestPage,
  normalizeUserUsage,
  normalizeUserUsageBreakdown,
  signInWithKey,
  signOutUser,
  type UserKey,
  userKeyQuery,
} from "./user-panel";

const unsubscribers: Array<() => void> = [];

function recordReasons(): UserSessionChangeReason[] {
  const reasons: UserSessionChangeReason[] = [];
  unsubscribers.push(subscribeUserSession((_token, reason) => reasons.push(reason)));
  return reasons;
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

/** Records the requests to /user/api`path` and answers with `respond`. */
function capture(
  method: "get" | "post" | "delete",
  path: string,
  respond: () => Response = () => HttpResponse.json({}),
) {
  const seen: Request[] = [];
  mockServer.use(
    http[method](`/user/api${path}`, ({ request }) => {
      seen.push(request.clone());
      return respond();
    }),
  );
  return seen;
}

describe("normalisers", () => {
  it("gives every missing or wrong field of a key a safe default", () => {
    expect(normalizeUserKey(null)).toEqual({
      id: "",
      name: "",
      keyMasked: "",
      enabled: false,
      expired: false,
      createdAt: 0,
      lastUsedAt: 0,
      expiresAt: 0,
      tokenLimit: 0,
      tokensUsed: 0,
      creditLimit: 0,
      creditsUsed: 0,
      callLimit: 0,
      successfulCalls: 0,
      requestsCount: 0,
      rpmLimit: 0,
      allowedModels: [],
      keysRequired: true,
    });
    const key = normalizeUserKey({
      id: "k1",
      name: " Production ",
      enabled: "yes",
      tokensUsed: "12",
      creditsUsed: 46.2,
      rpmLimit: Number.NaN,
      allowedModels: ["claude-sonnet-4.5", 7, "", null],
      accountIds: ["acc-1"],
      routingMode: "priority",
    });
    expect(key).toMatchObject({
      id: "k1",
      name: "Production",
      enabled: false,
      tokensUsed: 0,
      creditsUsed: 46.2,
      rpmLimit: 0,
      allowedModels: ["claude-sonnet-4.5"],
    });
    expect(key).not.toHaveProperty("accountIds");
    expect(key).not.toHaveProperty("routingMode");
  });

  it("makes a key that the admin limits card can take", () => {
    const key: UserKey = normalizeUserKey({ id: "k1", keyMasked: "sk-6e9****1827" });
    const asAdmin: ApiKey = key;
    expect(asAdmin.keyMasked).toBe("sk-6e9****1827");
  });

  it("pads or trims each usage series to the buckets and keeps ranges valid", () => {
    const usage = normalizeUserUsage(
      {
        range: "1y",
        bucket: "fortnight",
        buckets: [100, 200, 300],
        totals: { requests: 3, inTokens: 10, outTokens: 5 },
        keys: [
          { id: "k1", kind: "key", series: [{ requests: 1 }] },
          { id: "k1", kind: "other", series: [{}, {}, {}, {}, {}] },
        ],
        earlier: "none",
      },
      "7d",
    );
    expect(usage.range).toBe("7d");
    expect(usage.bucket).toBe("day");
    expect(usage.totals).toEqual({
      requests: 3,
      succeeded: 0,
      failed: 0,
      inTokens: 10,
      outTokens: 5,
      tokens: 15,
      credits: 0,
    });
    expect(usage.keys.map((entry) => entry.series.length)).toEqual([3, 3]);
    expect(usage.keys[0].series[0].requests).toBe(1);
    expect(usage.keys[1].kind).toBe("key");
    expect(usage).not.toHaveProperty("earlier");
    expect(usage).not.toHaveProperty("previous");
    expect(normalizeUserUsage(undefined)).toMatchObject({ range: "24h", buckets: [], keys: [] });
  });

  it("reads the stretch before the range, except for the lifetime", () => {
    const previous = {
      requests: 4,
      succeeded: 3,
      failed: 1,
      inTokens: 8,
      outTokens: 2,
      credits: -1,
    };
    expect(normalizeUserUsage({ range: "7d", previous }).previous).toEqual({
      requests: 4,
      succeeded: 3,
      failed: 1,
      inTokens: 8,
      outTokens: 2,
      tokens: 10,
      credits: 0,
    });
    expect(normalizeUserUsage({ range: "7d", previous: [1, 2] })).not.toHaveProperty("previous");
    expect(normalizeUserUsage({ range: "all", previous })).not.toHaveProperty("previous");
  });

  it("never passes accounts through a breakdown", () => {
    const breakdown = normalizeUserUsageBreakdown({
      ref: "key:k1",
      range: "30d",
      models: [{ id: "claude-opus-4.8", requests: 4, label: "x" }, "junk"],
      accounts: [{ id: "acc-1", label: "someone@example.com", requests: 4 }],
    });
    expect(breakdown.accounts).toEqual([]);
    expect(breakdown.models[0]).toEqual({
      id: "claude-opus-4.8",
      requests: 4,
      succeeded: 0,
      failed: 0,
      tokens: 0,
      credits: 0,
    });
    expect(breakdown.models[1].id).toBe("");
  });

  it("keeps only the holder's request fields and known error types", () => {
    const row = normalizeUserRequest({
      id: 11661,
      ts: 1731790000,
      model: "claude-opus-4.8",
      endpoint: "gopher",
      inTokens: 1830,
      outTokens: 185,
      success: false,
      status: 429,
      errorType: "brand_new_type",
      accountId: "acc-1",
      email: "someone@example.com",
      message: "upstream said no",
    });
    expect(row).toMatchObject({
      endpoint: "",
      totalTokens: 2015,
      errorType: "unknown",
      requestId: "",
      durationMs: 0,
    });
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("accountId");
    expect(row).not.toHaveProperty("email");
    expect(row).not.toHaveProperty("message");
    expect(normalizeUserRequest({ success: true, errorType: "timeout" }).errorType).toBe("");
  });

  it("keeps a known client and drops one this UI does not know", () => {
    expect(normalizeUserRequest({ client: "claude-code" }).client).toBe("claude-code");
    expect(normalizeUserRequest({ client: "codex" }).client).toBe("codex");
    expect(normalizeUserRequest({ client: "claude-cli/2.1.3 (external, cli)" }).client).toBe("");
    expect(normalizeUserRequest({}).client).toBe("");
  });

  it("fills a page's paging and sort from the request when the answer lacks it", () => {
    expect(normalizeUserRequestPage({ requests: "nope" }, { page: 3, pageSize: 500 })).toEqual({
      requests: [],
      total: 0,
      page: 3,
      pageSize: 100,
      sort: "time",
      order: "desc",
    });
    expect(
      normalizeUserRequestPage({ sort: "account", order: "up" }, { sort: "tokens", order: "asc" }),
    ).toMatchObject({ sort: "tokens", order: "asc" });
    expect(normalizeUserRequestPage({ sort: "credits", order: "asc" })).toMatchObject({
      sort: "credits",
      order: "asc",
    });
  });

  it("keeps the status counts whole, adds a missing All and leaves them out when not sent", () => {
    expect(
      normalizeUserRequestPage({ counts: { all: 12.4, succeeded: 10, failed: -3 } }).counts,
    ).toEqual({ all: 12, succeeded: 10, failed: 0 });
    expect(normalizeUserRequestPage({ counts: { succeeded: 4, failed: "2" } }).counts).toEqual({
      all: 4,
      succeeded: 4,
      failed: 0,
    });
    expect(normalizeUserRequestPage({ counts: [1, 2] })).not.toHaveProperty("counts");
    expect(normalizeUserRequestPage({})).not.toHaveProperty("counts");
  });
});

describe("requests", () => {
  it("signs in with the key in the body and stores the token where asked", async () => {
    const seen = capture("post", "/session", () =>
      HttpResponse.json({ token: "a".repeat(64), expiresAt: 2_000_000_000 }),
    );
    const reasons = recordReasons();
    await signInWithKey("sk-test", true);
    expect(await seen[0].json()).toEqual({ key: "sk-test" });
    expect(seen[0].headers.has("X-Admin-Token")).toBe(false);
    expect(localStorage.getItem(USER_TOKEN_KEY)).toBe("a".repeat(64));
    expect(localStorage.getItem("kiro_user_token_exp")).toBe("2000000000000");
    expect(reasons).toEqual(["signed-in"]);
  });

  it("fails a sign-in whose answer has no token and stores nothing", async () => {
    capture("post", "/session", () => HttpResponse.json({}));
    expect((await rejection(signInWithKey("sk-test", false))).status).toBe(401);
    expect(getUserToken()).toBeNull();
  });

  it("sends X-User-Token and never the admin token", async () => {
    setSession({ token: "mock-admin", expiresAt: 0, remember: false });
    setUserToken("user-token", false);
    const seen = capture("get", "/key", () => HttpResponse.json({ id: "k1" }));
    expect((await getUserKey()).id).toBe("k1");
    expect(seen[0].headers.get("X-User-Token")).toBe("user-token");
    expect(seen[0].headers.has("X-Admin-Token")).toBe(false);
  });

  it("sends the paging, status and sort the server takes", async () => {
    setUserToken("user-token", false);
    const seen = capture("get", "/requests", () => HttpResponse.json({}));
    await getUserRequests({ page: 2, pageSize: 1000, status: "error" });
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe("/user/api/requests");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "2",
      pageSize: "100",
      status: "error",
      sort: "time",
      order: "desc",
    });
    await getUserRequests({ sort: "tokens", order: "asc" });
    expect(Object.fromEntries(new URL(seen[1].url).searchParams)).toMatchObject({
      sort: "tokens",
      order: "asc",
    });
  });

  it("ends the session as expired on a 401 for the token it sent", async () => {
    setUserToken("user-token", true);
    const reasons = recordReasons();
    capture("get", "/key", () =>
      HttpResponse.json({ error: "Unauthorized", code: "user_session_expired" }, { status: 401 }),
    );
    const error = await rejection(getUserKey());
    expect(error.status).toBe(401);
    expect(getUserToken()).toBeNull();
    expect(reasons).toEqual(["expired"]);
  });

  it("keeps a newer session when a 401 arrives for the token it replaced", async () => {
    setUserToken("old-token", false);
    mockServer.use(
      http.get("/user/api/key", () => {
        setUserToken("new-token", false);
        return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
      }),
    );
    await rejection(getUserKey());
    expect(getUserToken()).toBe("new-token");
  });

  it("sends nothing without a token", async () => {
    const seen = capture("get", "/key");
    const error = await rejection(getUserKey());
    expect(error.status).toBe(401);
    expect(error.body).toMatchObject({ code: "user_session_expired" });
    expect(seen).toHaveLength(0);
  });

  it("signs out locally even when the server cannot be reached", async () => {
    setUserToken("user-token", true);
    const seen = capture("delete", "/session", () => HttpResponse.error());
    const reasons = recordReasons();
    await signOutUser();
    expect(seen[0].headers.get("X-User-Token")).toBe("user-token");
    expect(getUserToken()).toBeNull();
    expect(reasons).toEqual(["signed-out"]);
  });

  it("drops the panel's cached data when the session changes", async () => {
    setUserToken("user-token", false);
    capture("get", "/key", () => HttpResponse.json({ id: "k1" }));
    await queryClient.fetchQuery(userKeyQuery());
    expect(queryClient.getQueryData(queryKeys.userPanel.key())).toBeDefined();
    await signOutUser();
    expect(queryClient.getQueryData(queryKeys.userPanel.key())).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { apiRequest } from "@/lib/api/client";
import type { RecentRequestsResponse } from "@/lib/api/types";
import { setSession } from "@/lib/auth/session";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { inMemoryRequestsHandler } from "./mocks";

function list(query: Record<string, string>): Promise<RecentRequestsResponse> {
  return apiRequest<RecentRequestsResponse>("/observe/recent-requests", { query });
}

beforeEach(() => {
  setSession({ token: "mock-test", expiresAt: Date.now() + 3_600_000, remember: false });
});

describe("recent-requests mock", () => {
  it("normalizes paging like the server", async () => {
    expect(await list({ page: "0", pageSize: "abc" })).toMatchObject({ page: 1, pageSize: 25 });
    expect(await list({ pageSize: "500" })).toMatchObject({ pageSize: 200 });
    expect(await list({ limit: "40" })).toMatchObject({ pageSize: 40 });
    expect(await list({ pageSize: "10", limit: "40" })).toMatchObject({ pageSize: 10 });
    const res = await list({ sort: "nope", order: "sideways", status: "maybe" });
    expect(res).toMatchObject({ sort: "time", order: "desc", total: 320, persistent: true });
  });

  it("returns no rows but the real total past the last page", async () => {
    const res = await list({ page: "99" });
    expect(res.requests).toEqual([]);
    expect(res.total).toBe(320);
  });

  it("matches the full raw API key, which the rows never carry", async () => {
    const key = mockDb.apiKeys[0];
    const res = await list({ search: key.key.toUpperCase(), pageSize: "200" });
    expect(res.total).toBeGreaterThan(0);
    expect(res.requests.every((row) => row.apiKeyId === key.id)).toBe(true);
    expect(JSON.stringify(res)).not.toContain(key.key);
  });

  it("filters by status and sorts with a stable secondary order", async () => {
    const failed = await list({ status: "FAILED", pageSize: "200" });
    expect(failed.requests.every((row) => !row.success)).toBe(true);

    const res = await list({ sort: "status", order: "asc", pageSize: "200" });
    const ids = res.requests.map((row) => row.id ?? 0);
    const firstSuccess = res.requests.findIndex((row) => row.success);
    expect(res.requests.slice(0, firstSuccess).every((row) => !row.success)).toBe(true);
    expect(ids.slice(0, firstSuccess)).toEqual(
      [...ids.slice(0, firstSuccess)].sort((a, b) => a - b),
    );
  });

  it("serves the in-memory fallback without ids and at most 200 rows", async () => {
    mockServer.use(inMemoryRequestsHandler());
    const res = await list({ pageSize: "200", page: "1" });
    expect(res.persistent).toBe(false);
    expect(res.total).toBe(200);
    expect(res.requests.every((row) => row.id === undefined)).toBe(true);
  });
});

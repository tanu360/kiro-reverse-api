import { type HttpHandler, HttpResponse, http } from "msw";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { buildHeatmap, buildOverview } from "@/lib/mocks/fixtures";
import { apiUrl, mockDelay, requireAuth } from "@/lib/mocks/http";

const MAX_HEATMAP_WINDOW = 1440;
const DEFAULT_HEATMAP_WINDOW = 60;
const MAX_RECENT_ERRORS = 100;

/** Like Go: a missing, invalid or non-positive value falls back, larger values are capped. */
function clampParam(raw: string | null, fallback: number, max: number): number {
  // strconv.Atoi rejects trailing garbage such as "60abc".
  const value = raw !== null && /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

/** Go's queryFlag: 1, true, yes or on. */
function isFlag(raw: string | null): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

// /observe/recent-requests belongs to the Requests feature's mocks.
export const handlers: HttpHandler[] = [
  http.get(apiUrl("/observe/overview"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(
      buildOverview(mockDb.requests, mockNowUnix(), mockDb.startedAt, {
        errors: mockDb.errors,
        accounts: mockDb.accounts,
        allowOverUsage: mockDb.settings.allowOverUsage,
      }),
    );
  }),

  // Go's query params: windowMin, bucketMin, scope=global, top=N, sparse=1.
  http.get(apiUrl("/observe/account-heatmap"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const params = new URL(request.url).searchParams;
    const windowMin = clampParam(
      params.get("windowMin"),
      DEFAULT_HEATMAP_WINDOW,
      MAX_HEATMAP_WINDOW,
    );
    const top = clampParam(params.get("top"), 0, Number.MAX_SAFE_INTEGER);
    const { accounts, restCount, ...heatmap } = buildHeatmap(
      mockDb.requests,
      mockDb.accounts,
      windowMin,
      mockNowUnix(),
      {
        errors: mockDb.errors,
        bucketMin: clampParam(params.get("bucketMin"), 1, windowMin),
        scope: params.get("scope")?.toLowerCase() === "global" ? "global" : "all",
        top,
        sparse: isFlag(params.get("sparse")),
      },
    );
    // Go omits an empty account list (and the list itself with scope=global).
    return HttpResponse.json({
      ...heatmap,
      ...(accounts.length > 0 ? { accounts } : {}),
      ...(top > 0 ? { restCount } : {}),
    });
  }),

  http.get(apiUrl("/observe/model-mix"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json({ models: mockDb.modelMix });
  }),

  http.get(apiUrl("/observe/recent-errors"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const limit = clampParam(
      new URL(request.url).searchParams.get("limit"),
      MAX_RECENT_ERRORS,
      MAX_RECENT_ERRORS,
    );
    return HttpResponse.json({ errors: mockDb.errors.slice(0, limit) });
  }),
];

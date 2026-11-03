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

// /observe/recent-requests belongs to the Requests feature's mocks.
export const handlers: HttpHandler[] = [
  http.get(apiUrl("/observe/overview"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    return HttpResponse.json(buildOverview(mockDb.requests, mockNowUnix(), mockDb.startedAt));
  }),

  http.get(apiUrl("/observe/account-heatmap"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const windowMin = clampParam(
      new URL(request.url).searchParams.get("windowMin"),
      DEFAULT_HEATMAP_WINDOW,
      MAX_HEATMAP_WINDOW,
    );
    const heatmap = buildHeatmap(mockDb.requests, mockDb.accounts, windowMin, mockNowUnix());
    // Go sends null instead of an empty account list.
    return HttpResponse.json({
      ...heatmap,
      accounts: heatmap.accounts.length > 0 ? heatmap.accounts : null,
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

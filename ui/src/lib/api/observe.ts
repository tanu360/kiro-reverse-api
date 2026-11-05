import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import { getRecentRequests } from "./requests";
import type {
  HeatmapCell,
  HeatmapData,
  HeatmapResponse,
  ModelMixEntry,
  ModelMixResponse,
  ObserveError,
  ObserveOverview,
  RecentErrorsResponse,
} from "./types";

export function getObserveOverview(): Promise<ObserveOverview> {
  return apiRequest("/observe/overview");
}

/** Optional shaping for /observe/account-heatmap. Leaving all of them out keeps every account. */
export interface HeatmapParams {
  /** "global" leaves the accounts out, for views that read only the global row. */
  scope?: "global" | "all";
  /** Only the N busiest accounts over the last hour, busiest first; `restCount` counts the rest. */
  top?: number;
  /** Minutes summed per cell (default 1); offset N then means N buckets ago. */
  bucketMin?: number;
}

/** Fills the cells a sparse row left out, so every row has one cell per bucket, offset 0 first. */
function densify(cells: readonly HeatmapCell[], count: number): HeatmapCell[] {
  const dense: HeatmapCell[] = Array.from({ length: count }, (_, offset) => ({
    offset,
    reqs: 0,
    failures: 0,
  }));
  for (const cell of cells) {
    if (cell.offset >= 0 && cell.offset < count) dense[cell.offset] = cell;
  }
  return dense;
}

/**
 * Asks for sparse rows (only cells with traffic travel) and returns them dense, so callers get
 * the same shape as before. `accounts` is left out or null on the wire when there is none; it is
 * always an array here.
 */
export async function getAccountHeatmap(
  windowMin: number,
  params: HeatmapParams = {},
): Promise<HeatmapData> {
  const res = await apiRequest<HeatmapResponse>("/observe/account-heatmap", {
    query: {
      windowMin,
      sparse: 1,
      scope: params.scope === "global" ? "global" : undefined,
      top: params.top && params.top > 0 ? params.top : undefined,
      bucketMin: params.bucketMin && params.bucketMin > 1 ? params.bucketMin : undefined,
    },
  });
  const bucketMin = Math.max(1, res.bucketMin ?? 1);
  const count = Math.ceil(res.windowMin / bucketMin);
  return {
    ...res,
    bucketMin,
    global: { ...res.global, cells: densify(res.global.cells ?? [], count) },
    accounts: (res.accounts ?? []).map((row) => ({
      ...row,
      cells: densify(row.cells ?? [], count),
    })),
  };
}

export async function getModelMix(): Promise<ModelMixEntry[]> {
  const res = await apiRequest<ModelMixResponse>("/observe/model-mix");
  return res.models ?? [];
}

export async function getRecentErrors(limit: number): Promise<ObserveError[]> {
  const res = await apiRequest<RecentErrorsResponse>("/observe/recent-errors", {
    query: { limit },
  });
  return res.errors ?? [];
}

export function observeOverviewQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.overview(),
    queryFn: getObserveOverview,
  });
}

/**
 * live: false => meta.liveRefresh = false (SSE ticks skip it) and a 60 s poll instead.
 * scope, top and bucketMin shape the response (see HeatmapParams) and are part of the key.
 */
export function heatmapQuery(windowMin: number, options?: { live?: boolean } & HeatmapParams) {
  const { live = true, ...params } = options ?? {};
  return queryOptions({
    queryKey: queryKeys.observe.heatmap(windowMin, params),
    queryFn: () => getAccountHeatmap(windowMin, params),
    ...(live ? {} : { meta: { liveRefresh: false }, refetchInterval: 60_000 }),
  });
}

export function modelMixQuery() {
  return queryOptions({
    queryKey: queryKeys.observe.modelMix(),
    queryFn: getModelMix,
  });
}

export function recentErrorsQuery(limit: number) {
  return queryOptions({
    queryKey: queryKeys.observe.recentErrors(limit),
    queryFn: () => getRecentErrors(limit),
  });
}

/** Overview's recent-activity preview: page 1 of the requests list under an observe key. */
export function recentRequestsPreviewQuery(pageSize: number) {
  return queryOptions({
    queryKey: queryKeys.observe.recentRequests(pageSize),
    queryFn: () => getRecentRequests({ page: 1, pageSize }),
  });
}
